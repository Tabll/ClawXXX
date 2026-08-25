import { EventEmitter } from 'node:events';
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  KernelId,
  KernelLifecycleState,
  KernelRollbackSuggestion,
  KernelRuntimeSnapshot,
} from '@shared/kernels/contracts';
import type {
  KernelCrashRecord,
  KernelLogExport,
  KernelLogEntry,
  KernelLogLevel,
  KernelRuntimeDiagnostics,
} from '@shared/host-api/kernels';
import type { KernelRequestIdentity, KernelStdioEvent } from '@shared/kernels/runtime-protocol';
import {
  StdioKernelProcess,
  type KernelProcessDiagnostic,
  type KernelProcessLaunch,
} from './stdio-kernel-process';
import { InProcessKernelDriverRuntime, type InProcessKernelDriverLaunch } from './driver-runtime';
import { redactDiagnosticText } from './log-redaction';

type ManagedKernelRuntime = StdioKernelProcess | InProcessKernelDriverRuntime;
export type KernelRuntimeLaunch = KernelProcessLaunch | InProcessKernelDriverLaunch;

export type KernelLaunchResolver = (
  kernelId: KernelId,
  generation: number,
) => KernelRuntimeLaunch | Promise<KernelRuntimeLaunch>;

export type KernelRestartPolicy = {
  autoStart: boolean;
  autoRestart: boolean;
  maxRestarts: number;
  windowMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type KernelSupervisorRegistryOptions = {
  kernelIds?: KernelId[];
  restartPolicy?: Partial<KernelRestartPolicy>;
  logLimit?: number;
  crashHistoryLimit?: number;
  now?: () => Date;
  isLaunchAvailable?: (kernelId: KernelId) => boolean | Promise<boolean>;
};

type SupervisorSlot = {
  kernelId: KernelId;
  generation: number;
  state: KernelLifecycleState;
  desiredRunning: boolean;
  process?: ManagedKernelRuntime;
  lastSnapshot?: KernelRuntimeSnapshot;
  lastError?: string;
  policy: KernelRestartPolicy;
  crashTimes: number[];
  crashes: KernelCrashRecord[];
  healthFailures: number;
  rollbackSuggested?: KernelRollbackSuggestion;
  restartTimer?: NodeJS.Timeout;
  nextRestartAt?: string;
  logs: KernelLogEntry[];
  nextLogSequence: number;
};

const DEFAULT_POLICY: KernelRestartPolicy = {
  autoStart: false,
  autoRestart: true,
  maxRestarts: 3,
  windowMs: 60_000,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
};

const DEFAULT_KERNELS: KernelId[] = ['openclaw', 'deepseek-harness'];

function launchIsDriver(launch: KernelRuntimeLaunch): launch is InProcessKernelDriverLaunch {
  return 'kind' in launch && launch.kind === 'driver';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizePolicy(input: Partial<KernelRestartPolicy> | undefined): KernelRestartPolicy {
  const policy = { ...DEFAULT_POLICY, ...input };
  for (const key of ['maxRestarts', 'windowMs', 'baseDelayMs', 'maxDelayMs'] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 0) {
      throw new Error(`Invalid kernel restart policy field: ${key}`);
    }
  }
  if (policy.windowMs === 0 || policy.maxDelayMs < policy.baseDelayMs) {
    throw new Error('Invalid kernel restart policy window or delay range');
  }
  return policy;
}

export class KernelSupervisorRegistry extends EventEmitter {
  private readonly slots = new Map<KernelId, SupervisorSlot>();
  private readonly operationTails = new Map<KernelId, Promise<void>>();
  private readonly policyDefaults: KernelRestartPolicy;
  private readonly logLimit: number;
  private readonly crashHistoryLimit: number;
  private readonly now: () => Date;
  private logRoot?: string;
  private readonly logWriteTails = new Map<KernelId, Promise<void>>();

  constructor(
    private readonly resolveLaunch: KernelLaunchResolver,
    private readonly options: KernelSupervisorRegistryOptions = {},
  ) {
    super();
    this.policyDefaults = sanitizePolicy(options.restartPolicy);
    this.logLimit = options.logLimit ?? 1_000;
    this.crashHistoryLimit = options.crashHistoryLimit ?? 100;
    this.now = options.now ?? (() => new Date());
    for (const kernelId of options.kernelIds ?? DEFAULT_KERNELS) this.ensureSlot(kernelId);
  }

  async start(kernelId: KernelId): Promise<KernelRuntimeSnapshot> {
    return this.withKernelLock(kernelId, async () => {
      const slot = this.ensureSlot(kernelId);
      slot.desiredRunning = true;
      this.clearRestartTimer(slot);
      if (slot.state === 'crash-loop') this.resetRecoveryBudget(slot);
      if (slot.process?.snapshot().state === 'ready') return this.snapshotFor(slot);
      return this.startUnlocked(slot, 'manual');
    });
  }

  request<T = unknown>(
    kernelId: KernelId,
    method: string,
    params?: unknown,
    identity?: KernelRequestIdentity,
    timeoutMs?: number,
  ): Promise<T> {
    const process = this.slots.get(kernelId)?.process;
    if (!process || process.snapshot().state !== 'ready') {
      return Promise.reject(new Error(`Kernel ${kernelId} is not running`));
    }
    return process.request<T>(method, params, identity, timeoutMs);
  }

  async stop(kernelId: KernelId): Promise<void> {
    await this.withKernelLock(kernelId, async () => {
      const slot = this.ensureSlot(kernelId);
      slot.desiredRunning = false;
      this.clearRestartTimer(slot);
      await this.stopUnlocked(slot);
    });
  }

  async restart(kernelId: KernelId): Promise<KernelRuntimeSnapshot> {
    return this.withKernelLock(kernelId, async () => {
      const slot = this.ensureSlot(kernelId);
      slot.desiredRunning = false;
      this.clearRestartTimer(slot);
      await this.stopUnlocked(slot);
      this.resetRecoveryBudget(slot);
      slot.desiredRunning = true;
      return this.startUnlocked(slot, 'manual-restart');
    });
  }

  status(kernelId: KernelId): KernelRuntimeSnapshot {
    return this.snapshotFor(this.ensureSlot(kernelId));
  }

  snapshots(): KernelRuntimeSnapshot[] {
    return [...this.slots.values()].map(slot => this.snapshotFor(slot));
  }

  configureLogRoot(root: string): void {
    this.logRoot = resolve(root);
  }

  logDirectory(kernelId: KernelId): string | undefined {
    this.ensureSlot(kernelId);
    return this.logRoot ? join(this.logRoot, safeKernelDirectory(kernelId)) : undefined;
  }

  exportLogs(kernelId: KernelId): KernelLogExport {
    const entries = this.logs(kernelId, { limit: 1_000 });
    return {
      kernelId,
      fileName: `clawx-${safeKernelDirectory(kernelId)}-logs.jsonl`,
      content: entries.map(entry => JSON.stringify({
        ...entry,
        message: redactDiagnosticText(entry.message),
      })).join('\n') + (entries.length > 0 ? '\n' : ''),
      entryCount: entries.length,
    };
  }

  async flushLogs(kernelId?: KernelId): Promise<void> {
    if (kernelId) {
      await this.logWriteTails.get(kernelId);
      return;
    }
    await Promise.all(this.logWriteTails.values());
  }

  recordLog(
    kernelId: KernelId,
    generation: number,
    level: KernelLogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    const slot = this.ensureSlot(kernelId);
    if (slot.generation !== generation) return;
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${safeJson(fields)}` : '';
    this.addLog(slot, level, 'protocol', `${message}${suffix}`);
  }

  async health(kernelId: KernelId): Promise<KernelRuntimeSnapshot> {
    return this.withKernelLock(kernelId, async () => {
      const slot = this.ensureSlot(kernelId);
      if (!slot.process) throw new Error(`Kernel ${kernelId} is not running`);
      try {
        const snapshot = await slot.process.health();
        slot.healthFailures = 0;
        slot.state = 'ready';
        slot.lastSnapshot = snapshot;
        this.addLog(slot, 'debug', 'lifecycle', 'Health probe succeeded');
        return this.snapshotFor(slot);
      } catch (error) {
        slot.healthFailures += 1;
        slot.state = 'degraded';
        slot.lastError = redactDiagnosticText(errorMessage(error));
        this.addLog(slot, 'warn', 'lifecycle', `Health probe failed: ${slot.lastError}`);
        if (slot.healthFailures >= 3 && !slot.rollbackSuggested) {
          slot.rollbackSuggested = {
            at: this.now().toISOString(),
            artifactVersion: slot.process.artifactVersion,
            reason: 'health-failure',
            crashCount: slot.healthFailures,
          };
          this.emit('rollback-suggested', { kernelId, ...slot.rollbackSuggested });
        }
        this.emitStatus(slot);
        throw error;
      }
    });
  }

  logs(kernelId: KernelId, input: { afterSequence?: number; limit?: number } = {}): KernelLogEntry[] {
    const slot = this.ensureSlot(kernelId);
    const after = Number.isSafeInteger(input.afterSequence) && (input.afterSequence ?? 0) >= 0
      ? input.afterSequence ?? 0
      : 0;
    const limit = Number.isSafeInteger(input.limit)
      ? Math.min(1_000, Math.max(1, input.limit ?? 200))
      : 200;
    return slot.logs.filter(entry => entry.sequence > after).slice(-limit).map(entry => ({ ...entry }));
  }

  diagnostics(kernelId: KernelId): KernelRuntimeDiagnostics {
    const slot = this.ensureSlot(kernelId);
    return {
      snapshot: this.snapshotFor(slot),
      crashes: slot.crashes.map(crash => ({ ...crash })),
      logs: slot.logs.map(entry => ({ ...entry })),
      logDirectory: this.logDirectory(kernelId),
    };
  }

  setPolicy(kernelId: KernelId, patch: Partial<Pick<KernelRestartPolicy, 'autoStart' | 'autoRestart'>>): KernelRuntimeSnapshot {
    const slot = this.ensureSlot(kernelId);
    slot.policy = { ...slot.policy, ...patch };
    if (patch.autoRestart === false) this.clearRestartTimer(slot);
    this.addLog(slot, 'info', 'lifecycle', `Policy updated: ${JSON.stringify(patch)}`);
    this.emitStatus(slot);
    return this.snapshotFor(slot);
  }

  async autoStartAll(policies: Record<string, boolean> = {}): Promise<void> {
    for (const slot of this.slots.values()) {
      if (Object.prototype.hasOwnProperty.call(policies, slot.kernelId)) {
        slot.policy = { ...slot.policy, autoStart: policies[slot.kernelId] === true };
      }
    }
    const candidates: KernelId[] = [];
    for (const slot of this.slots.values()) {
      if (!slot.policy.autoStart) continue;
      if (this.options.isLaunchAvailable && !await this.options.isLaunchAvailable(slot.kernelId)) {
        this.addLog(slot, 'debug', 'lifecycle', 'Auto-start skipped because no launch provider is registered');
        continue;
      }
      candidates.push(slot.kernelId);
    }
    await Promise.allSettled(candidates.map(kernelId => this.start(kernelId)));
  }

  isVersionInUse(kernelId: KernelId, artifactVersion: string): boolean {
    const process = this.slots.get(kernelId)?.process;
    if (!process?.isRunning) return false;
    const snapshot = process.snapshot();
    return process.artifactVersion === artifactVersion
      || (!process.artifactVersion && snapshot.version === artifactVersion);
  }

  isKernelBusy(kernelId: KernelId): boolean {
    const slot = this.slots.get(kernelId);
    return Boolean(slot?.process?.isRunning || slot?.state === 'starting' || slot?.state === 'stopping');
  }

  async isLaunchAvailable(kernelId: KernelId): Promise<boolean> {
    return this.options.isLaunchAvailable ? this.options.isLaunchAvailable(kernelId) : true;
  }

  async stopAll(): Promise<void> {
    await this.stopAllForQuit(10_000);
  }

  async stopAllForQuit(deadlineMs = 5_000): Promise<void> {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
      throw new Error('Kernel shutdown deadline must be a positive integer');
    }
    for (const slot of this.slots.values()) {
      slot.desiredRunning = false;
      this.clearRestartTimer(slot);
    }
    const completion = Promise.allSettled([...this.slots.keys()].map(kernelId => this.stop(kernelId)));
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), deadlineMs);
      timeout.unref?.();
    });
    const outcome = await Promise.race([completion.then(() => 'stopped' as const), deadline]);
    if (timeout) clearTimeout(timeout);
    if (outcome === 'timeout') {
      this.emit('shutdown-timeout', { deadlineMs });
      await this.forceTerminateAll();
    }
  }

  async forceTerminateAll(): Promise<void> {
    const slots = [...this.slots.values()];
    for (const slot of slots) {
      slot.desiredRunning = false;
      this.clearRestartTimer(slot);
    }
    await Promise.allSettled(slots.map(async (slot) => {
      const process = slot.process;
      if (!process) return;
      await process.forceTerminate();
      if (slot.process === process) slot.process = undefined;
      slot.lastSnapshot = process.snapshot();
      slot.state = 'stopped';
      this.addLog(slot, 'warn', 'lifecycle', 'Runtime process tree was force-terminated');
      this.emitStatus(slot);
    }));
  }

  private async startUnlocked(
    slot: SupervisorSlot,
    cause: 'manual' | 'manual-restart' | 'automatic',
  ): Promise<KernelRuntimeSnapshot> {
    if (slot.process?.snapshot().state === 'ready') return this.snapshotFor(slot);
    const generation = slot.generation + 1;
    let launch: KernelRuntimeLaunch;
    try {
      launch = await this.resolveLaunch(slot.kernelId, generation);
    } catch (error) {
      slot.state = 'not-installed';
      slot.lastError = redactDiagnosticText(errorMessage(error));
      this.addLog(slot, 'error', 'lifecycle', `Launch resolution failed: ${slot.lastError}`);
      this.emitStatus(slot);
      throw error;
    }
    slot.generation = generation;
    slot.state = 'starting';
    slot.lastError = undefined;
    slot.nextRestartAt = undefined;
    const process = launchIsDriver(launch)
      ? new InProcessKernelDriverRuntime(slot.kernelId, generation, launch)
      : new StdioKernelProcess(slot.kernelId, generation, launch);
    slot.process = process;
    this.addLog(
      slot,
      'info',
      'lifecycle',
      `Starting generation ${generation}${launch.artifactVersion ? ` (${launch.artifactVersion})` : ''} [${cause}]`,
    );
    this.attachProcess(slot, process);
    this.emitStatus(slot);
    try {
      const snapshot = await process.start();
      if (slot.process !== process || slot.generation !== generation) {
        await process.stop();
        throw new Error(`Kernel ${slot.kernelId} startup was superseded`);
      }
      slot.state = 'ready';
      slot.healthFailures = 0;
      slot.lastSnapshot = snapshot;
      this.addLog(slot, 'info', 'lifecycle', `Generation ${generation} is ready (pid=${snapshot.pid})`);
      this.emitStatus(slot);
      return this.snapshotFor(slot);
    } catch (error) {
      if (slot.process === process) slot.process = undefined;
      await process.stop().catch(() => {});
      slot.lastSnapshot = process.snapshot();
      this.recordCrash(slot, generation, launch.artifactVersion, error);
      throw error;
    }
  }

  private async stopUnlocked(slot: SupervisorSlot): Promise<void> {
    const process = slot.process;
    if (!process) {
      slot.state = slot.state === 'not-installed' ? 'not-installed' : 'stopped';
      this.emitStatus(slot);
      return;
    }
    slot.state = 'stopping';
    this.addLog(slot, 'info', 'lifecycle', `Stopping generation ${process.generation}`);
    this.emitStatus(slot);
    // Detach first so late events and exits from the old generation are ignored.
    slot.process = undefined;
    await process.stop();
    slot.lastSnapshot = process.snapshot();
    slot.state = 'stopped';
    slot.lastError = undefined;
    this.addLog(slot, 'info', 'lifecycle', `Generation ${process.generation} stopped`);
    this.emitStatus(slot);
  }

  private attachProcess(slot: SupervisorSlot, process: ManagedKernelRuntime): void {
    process.on('event', (event: KernelStdioEvent) => {
      if (slot.process !== process || slot.generation !== event.generation) return;
      this.emit('event', event);
    });
    process.on('diagnostic', (diagnostic: KernelProcessDiagnostic) => {
      if (slot.process !== process || slot.generation !== diagnostic.generation) return;
      const level: KernelLogLevel = diagnostic.stream === 'protocol' ? 'error' : 'warn';
      const messages = diagnostic.message.split(/\r?\n/).filter(Boolean);
      for (const message of messages) this.addLog(slot, level, diagnostic.stream, message);
      this.emit('diagnostic', diagnostic);
    });
    process.once('unexpected-exit', (error: Error) => {
      void this.withKernelLock(slot.kernelId, async () => {
        if (slot.process !== process || slot.generation !== process.generation) return;
        slot.process = undefined;
        slot.lastSnapshot = process.snapshot();
        this.recordCrash(slot, process.generation, process.artifactVersion, error);
      });
    });
  }

  private recordCrash(
    slot: SupervisorSlot,
    generation: number,
    artifactVersion: string | undefined,
    error: unknown,
  ): void {
    const timestamp = this.now();
    const message = redactDiagnosticText(errorMessage(error));
    const record: KernelCrashRecord = {
      kernelId: slot.kernelId,
      generation,
      timestamp: timestamp.toISOString(),
      artifactVersion,
      message,
    };
    slot.crashes.push(record);
    if (slot.crashes.length > this.crashHistoryLimit) slot.crashes.splice(0, slot.crashes.length - this.crashHistoryLimit);
    const cutoff = timestamp.getTime() - slot.policy.windowMs;
    slot.crashTimes = [...slot.crashTimes.filter(value => value >= cutoff), timestamp.getTime()];
    slot.lastError = message;
    slot.state = 'failed';
    this.addLog(slot, 'error', 'lifecycle', `Generation ${generation} crashed: ${message}`);
    this.emit('crash', record);

    if (!slot.desiredRunning || !slot.policy.autoRestart) {
      this.emitStatus(slot);
      return;
    }
    if (slot.crashTimes.length > slot.policy.maxRestarts) {
      slot.state = 'crash-loop';
      slot.rollbackSuggested = {
        at: timestamp.toISOString(),
        artifactVersion,
        reason: 'crash-loop',
        crashCount: slot.crashTimes.length,
      };
      this.addLog(slot, 'error', 'lifecycle', 'Restart budget exhausted; rollback is suggested');
      this.emit('rollback-suggested', { kernelId: slot.kernelId, ...slot.rollbackSuggested });
      this.emitStatus(slot);
      return;
    }
    this.scheduleRestart(slot);
    this.emitStatus(slot);
  }

  private scheduleRestart(slot: SupervisorSlot): void {
    this.clearRestartTimer(slot);
    const attempt = Math.max(1, slot.crashTimes.length);
    const delayMs = Math.min(
      slot.policy.maxDelayMs,
      slot.policy.baseDelayMs * 2 ** Math.max(0, attempt - 1),
    );
    slot.nextRestartAt = new Date(this.now().getTime() + delayMs).toISOString();
    this.addLog(slot, 'warn', 'lifecycle', `Automatic restart ${attempt} scheduled in ${delayMs} ms`);
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = undefined;
      slot.nextRestartAt = undefined;
      void this.withKernelLock(slot.kernelId, async () => {
        if (!slot.desiredRunning || slot.process || slot.state === 'crash-loop') return;
        await this.startUnlocked(slot, 'automatic');
      }).catch(() => {
        // startUnlocked records the failure and schedules the next bounded try.
      });
    }, delayMs);
    slot.restartTimer.unref?.();
  }

  private snapshotFor(slot: SupervisorSlot): KernelRuntimeSnapshot {
    const base = slot.process?.snapshot() ?? slot.lastSnapshot;
    const diagnostics = slot.logs
      .filter(entry => entry.level === 'error' || entry.stream === 'protocol')
      .slice(-20)
      .map(entry => entry.message);
    return {
      kernelId: slot.kernelId,
      state: slot.state,
      generation: slot.generation,
      version: base?.version,
      artifactVersion: base?.artifactVersion,
      pid: slot.process?.pid,
      ownership: slot.process ? 'clawx-owned' : base?.ownership,
      autoStart: slot.policy.autoStart,
      autoRestart: slot.policy.autoRestart,
      restartCount: slot.crashTimes.length,
      restartBudget: slot.policy.maxRestarts,
      restartWindowMs: slot.policy.windowMs,
      nextRestartAt: slot.nextRestartAt,
      rollbackSuggested: slot.rollbackSuggested,
      lastExit: base?.lastExit,
      lastError: slot.lastError,
      startedAt: slot.process ? base?.startedAt : undefined,
      lastHealthAt: base?.lastHealthAt,
      startupDurationMs: base?.startupDurationMs,
      rssBytes: base?.rssBytes,
      runtimeTransport: base?.runtimeTransport,
      capabilities: base?.capabilities,
      diagnostics,
    };
  }

  private ensureSlot(kernelId: KernelId): SupervisorSlot {
    const existing = this.slots.get(kernelId);
    if (existing) return existing;
    const slot: SupervisorSlot = {
      kernelId,
      generation: 0,
      state: 'stopped',
      desiredRunning: false,
      policy: { ...this.policyDefaults },
      crashTimes: [],
      crashes: [],
      healthFailures: 0,
      logs: [],
      nextLogSequence: 1,
    };
    this.slots.set(kernelId, slot);
    return slot;
  }

  private resetRecoveryBudget(slot: SupervisorSlot): void {
    slot.crashTimes = [];
    slot.healthFailures = 0;
    slot.rollbackSuggested = undefined;
    slot.lastError = undefined;
    if (slot.state === 'crash-loop' || slot.state === 'failed' || slot.state === 'degraded') {
      slot.state = 'stopped';
    }
  }

  private clearRestartTimer(slot: SupervisorSlot): void {
    if (slot.restartTimer) clearTimeout(slot.restartTimer);
    slot.restartTimer = undefined;
    slot.nextRestartAt = undefined;
  }

  private addLog(
    slot: SupervisorSlot,
    level: KernelLogLevel,
    stream: KernelLogEntry['stream'],
    message: string,
  ): void {
    const entry: KernelLogEntry = {
      sequence: slot.nextLogSequence++,
      kernelId: slot.kernelId,
      generation: slot.generation,
      timestamp: this.now().toISOString(),
      level,
      stream,
      message: redactDiagnosticText(message),
    };
    slot.logs.push(entry);
    if (slot.logs.length > this.logLimit) slot.logs.splice(0, slot.logs.length - this.logLimit);
    this.persistLog(entry);
    this.emit('log', entry);
  }

  private persistLog(entry: KernelLogEntry): void {
    const directory = this.logDirectory(entry.kernelId);
    if (!directory) return;
    const path = join(directory, 'runtime.jsonl');
    const previous = this.logWriteTails.get(entry.kernelId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
      await chmod(path, 0o600).catch(() => undefined);
    }).catch(() => undefined);
    this.logWriteTails.set(entry.kernelId, next);
    void next.then(() => {
      if (this.logWriteTails.get(entry.kernelId) === next) this.logWriteTails.delete(entry.kernelId);
    });
  }

  private emitStatus(slot: SupervisorSlot): void {
    this.emit('status', this.snapshotFor(slot));
  }

  private withKernelLock<T>(kernelId: KernelId, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(kernelId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const tail = result.then(() => {}, () => {});
    this.operationTails.set(kernelId, tail);
    void tail.finally(() => {
      if (this.operationTails.get(kernelId) === tail) this.operationTails.delete(kernelId);
    });
    return result;
  }
}

function safeKernelDirectory(kernelId: KernelId): string {
  const value = String(kernelId);
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : 'unknown-kernel';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"serialization":"failed"}';
  }
}
