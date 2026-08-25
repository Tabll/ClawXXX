import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  KernelGeneration,
  KernelId,
  KernelRuntimeExit,
  KernelRuntimeSnapshot,
} from '@shared/kernels/contracts';
import {
  KERNEL_STDIO_PROTOCOL,
  isKernelStdioMessage,
  type KernelRequestIdentity,
  type KernelStdioEvent,
  type KernelStdioHostRequest,
  type KernelStdioHostResponse,
  type KernelStdioReady,
  type KernelStdioRequest,
  type KernelStdioResponse,
} from '@shared/kernels/runtime-protocol';

export type KernelProcessLaunch = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Immutable package-manager artifact selected before this process starts. */
  artifactVersion?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  onProcessReady?(identity: KernelOwnedProcessIdentity): Promise<void> | void;
  onProcessExit?(identity: KernelOwnedProcessIdentity): Promise<void> | void;
  handleHostRequest?(request: KernelHostRequest): Promise<unknown>;
};

export type KernelOwnedProcessIdentity = {
  kernelId: KernelId;
  generation: KernelGeneration;
  pid: number;
  artifactVersion: string;
};

export type KernelHostRequest = KernelOwnedProcessIdentity & {
  requestId: string;
  method: string;
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type KernelProcessDiagnostic = {
  kernelId: KernelId;
  generation: KernelGeneration;
  stream: 'stderr' | 'protocol';
  message: string;
};

export type KernelProcessExit = KernelRuntimeExit & {
  kernelId: KernelId;
  generation: KernelGeneration;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ESRCH';
}

async function runWindowsTaskKill(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });
    killer.once('error', () => resolve());
    killer.once('exit', () => resolve());
  });
}

/** Terminate the complete process tree created for a kernel, never a shell command. */
export async function terminateOwnedKernelProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): Promise<void> {
  const pid = child.pid;
  if (!pid || pid <= 0) return;
  if (process.platform === 'win32') {
    await runWindowsTaskKill(pid);
    return;
  }
  try {
    // Spawned kernels are process-group leaders (`detached: true` on POSIX).
    process.kill(-pid, signal);
  } catch (error) {
    if (isNoSuchProcess(error)) return;
    try {
      child.kill(signal);
    } catch (fallbackError) {
      if (!isNoSuchProcess(fallbackError)) throw fallbackError;
    }
  }
}

export class StdioKernelProcess extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: KernelStdioReady;
  private readonly pending = new Map<string, PendingRequest>();
  private stopping = false;
  private exitHandled = false;
  private unexpectedExitEmitted = false;
  private startedAt?: string;
  private lastHealthAt?: string;
  private lastExit?: KernelProcessExit;
  private readonly hostRequestIds = new Set<string>();
  private registeredProcessIdentity?: KernelOwnedProcessIdentity;

  constructor(
    readonly kernelId: KernelId,
    readonly generation: KernelGeneration,
    private readonly launch: KernelProcessLaunch,
  ) {
    super();
  }

  get artifactVersion(): string | undefined {
    return this.launch.artifactVersion;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get isRunning(): boolean {
    return Boolean(this.child && !this.exitHandled);
  }

  async start(): Promise<KernelRuntimeSnapshot> {
    if (this.child) throw new Error(`Kernel ${this.kernelId} is already started`);
    this.stopping = false;
    this.exitHandled = false;
    this.unexpectedExitEmitted = false;
    this.lastExit = undefined;
    this.startedAt = new Date().toISOString();
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd,
      env: {
        ...process.env,
        ...this.launch.env,
        CLAWX_KERNEL_ID: this.kernelId,
        CLAWX_KERNEL_GENERATION: String(this.generation),
        ...(this.launch.artifactVersion
          ? { CLAWX_KERNEL_ARTIFACT_VERSION: this.launch.artifactVersion }
          : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      shell: false,
    });
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.emit('diagnostic', {
        kernelId: this.kernelId,
        generation: this.generation,
        stream: 'stderr',
        message: chunk,
      } satisfies KernelProcessDiagnostic);
    });
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdout.on('line', (line) => this.handleLine(line));
    child.once('exit', (code, signal) => this.handleExit(code, signal));
    child.once('error', (error) => this.handleExit(undefined, undefined, error));

    const ready = await new Promise<KernelStdioReady>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Kernel ${this.kernelId} did not become ready before timeout`));
      }, this.launch.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
      const onReady = (message: KernelStdioReady) => {
        cleanup();
        resolve(message);
      };
      const onExit = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.off('ready', onReady);
        this.off('unexpected-exit', onExit);
      };
      this.once('ready', onReady);
      this.once('unexpected-exit', onExit);
    });
    const identity = this.ownedIdentity(ready.pid, ready.version);
    await this.launch.onProcessReady?.(identity);
    this.registeredProcessIdentity = identity;
    return this.buildSnapshot('ready', ready);
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    identity?: KernelRequestIdentity,
    timeoutMs = 10_000,
  ): Promise<T> {
    return this.sendRequest(method, params, identity, timeoutMs, false);
  }

  async health(timeoutMs = 3_000): Promise<KernelRuntimeSnapshot> {
    const result = await this.request<unknown>('runtime.health', undefined, undefined, timeoutMs);
    if (!result || typeof result !== 'object' || (result as Record<string, unknown>).ready !== true) {
      throw new Error(`Kernel ${this.kernelId} returned an unhealthy response`);
    }
    this.lastHealthAt = new Date().toISOString();
    return this.snapshot();
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const timeoutMs = this.launch.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    try {
      if (this.ready && !this.exitHandled) {
        await this.sendRequest('runtime.shutdown', undefined, undefined, timeoutMs, true);
      }
    } catch {
      // The bounded process-tree termination below owns shutdown completion.
    }

    // Always signal the process group after the graceful protocol request. A
    // runtime may exit its root process while leaving tools or channel workers.
    await terminateOwnedKernelProcessTree(child, 'SIGTERM').catch(() => {});
    await this.waitForExit(timeoutMs).catch(async () => {
      await terminateOwnedKernelProcessTree(child, 'SIGKILL').catch(() => {});
      await this.waitForExit(Math.min(timeoutMs, 1_000)).catch(() => {});
    });
    // The root may already be gone while a descendant remains in its group.
    await terminateOwnedKernelProcessTree(child, 'SIGKILL').catch(() => {});
    if (this.child === child) this.child = undefined;
    this.ready = undefined;
    this.stopping = false;
  }

  async forceTerminate(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    await terminateOwnedKernelProcessTree(child, 'SIGKILL').catch(() => {});
    await this.waitForExit(1_000).catch(() => {});
    if (this.child === child) this.child = undefined;
    this.ready = undefined;
    this.stopping = false;
  }

  snapshot(): KernelRuntimeSnapshot {
    const state = this.ready ? 'ready' : this.child && !this.exitHandled ? 'starting' : 'stopped';
    return this.buildSnapshot(state, this.ready);
  }

  private buildSnapshot(
    state: KernelRuntimeSnapshot['state'],
    ready?: KernelStdioReady,
  ): KernelRuntimeSnapshot {
    return {
      kernelId: this.kernelId,
      state,
      generation: this.generation,
      version: ready?.version,
      artifactVersion: this.launch.artifactVersion ?? ready?.version,
      pid: ready?.pid ?? (this.exitHandled ? undefined : this.child?.pid),
      ownership: 'clawx-owned',
      runtimeTransport: 'stdio-jsonl',
      startedAt: this.startedAt,
      lastHealthAt: this.lastHealthAt,
      startupDurationMs: ready?.startupDurationMs,
      rssBytes: ready?.rssBytes,
      capabilities: ready?.capabilities,
      lastExit: this.lastExit,
      diagnostics: [],
    };
  }

  private sendRequest<T = unknown>(
    method: string,
    params: unknown,
    identity: KernelRequestIdentity | undefined,
    timeoutMs: number,
    allowStopping: boolean,
  ): Promise<T> {
    if (!this.child || !this.ready || (!allowStopping && this.stopping) || this.exitHandled) {
      return Promise.reject(new Error(`Kernel ${this.kernelId} is not ready`));
    }
    const requestId = randomUUID();
    const message: KernelStdioRequest = {
      protocol: KERNEL_STDIO_PROTOCOL,
      type: 'request',
      requestId,
      kernelId: this.kernelId,
      generation: this.generation,
      method,
      ...(identity ? { identity } : {}),
      ...(params === undefined ? {} : { params }),
    };
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Kernel request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.child!.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  private handleLine(line: string): void {
    if (line.length > 1_048_576) {
      this.protocolViolation('stdout frame exceeds 1 MiB');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.protocolViolation('stdout contained non-JSON diagnostics');
      return;
    }
    if (!isKernelStdioMessage(parsed)) {
      this.protocolViolation('stdout contained an invalid protocol message');
      return;
    }
    if (parsed.kernelId !== this.kernelId || parsed.generation !== this.generation) {
      this.protocolViolation('message crossed kernel or generation scope');
      return;
    }
    if (parsed.type === 'ready') {
      if (this.ready) return this.protocolViolation('runtime sent ready twice');
      if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || parsed.pid !== this.child?.pid) {
        return this.protocolViolation('runtime ready PID does not match the owned child process');
      }
      if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
        return this.protocolViolation('runtime ready version is missing');
      }
      if (this.launch.artifactVersion && parsed.version !== this.launch.artifactVersion) {
        return this.protocolViolation(
          `runtime version ${parsed.version} does not match artifact ${this.launch.artifactVersion}`,
        );
      }
      this.ready = parsed;
      this.lastHealthAt = new Date().toISOString();
      this.emit('ready', parsed);
      return;
    }
    if (!this.ready) return this.protocolViolation(`runtime sent ${parsed.type} before ready`);
    if (parsed.type === 'response') {
      this.handleResponse(parsed);
      return;
    }
    if (parsed.type === 'host-request') {
      this.handleHostRequest(parsed);
      return;
    }
    this.handleEvent(parsed);
  }

  private handleHostRequest(request: KernelStdioHostRequest): void {
    if (!request.requestId || request.requestId.length > 256 || !request.method || request.method.length > 128) {
      this.protocolViolation('host request has an invalid identity or method');
      return;
    }
    if (this.hostRequestIds.has(request.requestId)) {
      this.protocolViolation(`host request replayed requestId ${request.requestId}`);
      return;
    }
    this.hostRequestIds.add(request.requestId);
    if (this.hostRequestIds.size > 4_096) {
      this.protocolViolation('host request replay window is exhausted');
      return;
    }
    const identity = this.registeredProcessIdentity;
    if (!identity) {
      this.protocolViolation('host request arrived before process registration');
      return;
    }
    void Promise.resolve().then(async () => {
      if (!this.launch.handleHostRequest) throw new Error('Kernel host requests are not enabled');
      return this.launch.handleHostRequest({
        ...identity,
        requestId: request.requestId,
        method: request.method,
        ...(request.params === undefined ? {} : { params: request.params }),
      });
    }).then(
      result => this.writeHostResponse(request.requestId, true, result),
      error => this.writeHostResponse(
        request.requestId,
        false,
        undefined,
        error instanceof Error ? error.message : 'Kernel host request was denied',
      ),
    );
  }

  private writeHostResponse(
    requestId: string,
    ok: boolean,
    result?: unknown,
    error?: string,
  ): void {
    const child = this.child;
    if (!child || this.exitHandled || !this.ready) return;
    const message: KernelStdioHostResponse = {
      protocol: KERNEL_STDIO_PROTOCOL,
      type: 'host-response',
      requestId,
      kernelId: this.kernelId,
      generation: this.generation,
      ok,
      ...(ok ? { result } : { error: { code: 'HOST_REQUEST_DENIED', message: error ?? 'Host request denied' } }),
    };
    child.stdin.write(`${JSON.stringify(message)}\n`, writeError => {
      if (writeError) this.protocolViolation('failed to write host response');
    });
  }

  private ownedIdentity(pid: number, runtimeVersion: string): KernelOwnedProcessIdentity {
    return {
      kernelId: this.kernelId,
      generation: this.generation,
      pid,
      artifactVersion: this.launch.artifactVersion ?? runtimeVersion,
    };
  }

  private handleResponse(response: KernelStdioResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) return this.protocolViolation(`response has unknown requestId ${response.requestId}`);
    clearTimeout(pending.timeout);
    this.pending.delete(response.requestId);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error?.message ?? 'Kernel request failed'));
  }

  private handleEvent(event: KernelStdioEvent): void {
    if (!event.identity || event.eventSeq < 1 || !Number.isSafeInteger(event.eventSeq)) {
      return this.protocolViolation('event is missing a valid identity or event sequence');
    }
    if (event.nativeEventId !== undefined && (
      typeof event.nativeEventId !== 'string'
      || event.nativeEventId.length === 0
      || event.nativeEventId.length > 512
    )) {
      return this.protocolViolation('event has an invalid native event identity');
    }
    this.emit('event', event);
  }

  private protocolViolation(message: string): void {
    const error = new Error(`Kernel ${this.kernelId} protocol violation: ${message}`);
    this.emit('diagnostic', {
      kernelId: this.kernelId,
      generation: this.generation,
      stream: 'protocol',
      message: error.message,
    } satisfies KernelProcessDiagnostic);
    this.emit('protocol-error', error);
    this.emitUnexpectedExit(error);
    void this.forceTerminate();
  }

  private handleExit(code?: number | null, signal?: NodeJS.Signals | null, cause?: Error): void {
    if (this.exitHandled) return;
    this.exitHandled = true;
    const error = cause ?? new Error(
      `Kernel ${this.kernelId} exited (code=${String(code)}, signal=${String(signal)})`,
    );
    this.lastExit = {
      kernelId: this.kernelId,
      generation: this.generation,
      at: new Date().toISOString(),
      code,
      signal,
      unexpected: !this.stopping,
      message: error.message,
    };
    this.ready = undefined;
    const registeredIdentity = this.registeredProcessIdentity;
    this.registeredProcessIdentity = undefined;
    this.hostRequestIds.clear();
    if (registeredIdentity) void Promise.resolve(this.launch.onProcessExit?.(registeredIdentity)).catch(() => undefined);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('exit', this.lastExit);
    if (!this.stopping) this.emitUnexpectedExit(error);
  }

  private emitUnexpectedExit(error: unknown): void {
    if (this.unexpectedExitEmitted) return;
    this.unexpectedExitEmitted = true;
    this.emit('unexpected-exit', asError(error));
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (!this.child || this.exitHandled) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Kernel ${this.kernelId} did not exit before timeout`));
      }, timeoutMs);
      const onExit = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.off('exit', onExit);
      };
      this.once('exit', onExit);
    });
  }
}
