import { EventEmitter } from 'node:events';
import type {
  KernelDriver,
  KernelDriverHost,
  CanonicalEntityController,
  KernelEventEnvelopeV1,
  KernelId,
  KernelRunConfiguration,
  KernelRunIdentity,
  KernelRunRequest,
  KernelRuntimeSnapshot,
} from '@shared/kernels/contracts';
import type { KernelRequestIdentity, KernelStdioEvent } from '@shared/kernels/runtime-protocol';
import type { KernelProcessDiagnostic } from './stdio-kernel-process';

export type InProcessKernelDriverLaunch = {
  kind: 'driver';
  driver: KernelDriver;
  host: KernelDriverHost;
  artifactVersion?: string;
};

type ForceTerminableDriver = KernelDriver & { forceTerminate?(): Promise<void> };

function requireIdentity(identity: KernelRequestIdentity | undefined): KernelRequestIdentity {
  if (!identity) throw new Error('Kernel request identity is required');
  return identity;
}

/**
 * Adapts a Main-owned KernelDriver to the same supervisor surface as a stdio
 * runtime. This lets the OpenClaw compatibility driver and future native
 * in-process drivers share lifecycle, generation and routing guarantees with
 * out-of-process runtime hosts.
 */
export class InProcessKernelDriverRuntime extends EventEmitter {
  private running = false;
  private lastSnapshot?: KernelRuntimeSnapshot;

  constructor(
    readonly kernelId: KernelId,
    readonly generation: number,
    private readonly launch: InProcessKernelDriverLaunch,
  ) {
    super();
    if (launch.driver.definition.id !== kernelId) {
      throw new Error(`Kernel driver identity mismatch: ${launch.driver.definition.id} != ${kernelId}`);
    }
  }

  get artifactVersion(): string | undefined {
    return this.launch.artifactVersion;
  }

  get pid(): number | undefined {
    return this.lastSnapshot?.pid;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<KernelRuntimeSnapshot> {
    if (this.running) throw new Error(`Kernel ${this.kernelId} is already started`);
    const host: KernelDriverHost = {
      ...this.launch.host,
      emit: async (event) => {
        this.assertEventIdentity(event);
        await this.launch.host.emit(event);
        this.emit('event', {
          protocol: 'clawx.kernel-stdio/v1',
          type: 'event',
          kernelId: this.kernelId,
          generation: this.generation,
          identity: {
            conversationId: event.conversationId,
            turnId: event.turnId,
            runId: event.runId,
          },
          eventSeq: event.eventSeq,
          ...(event.nativeEventId ? { nativeEventId: event.nativeEventId } : {}),
          event: event.event,
        } satisfies KernelStdioEvent);
      },
    };
    await this.launch.driver.initialize(host);
    const snapshot = await this.launch.driver.start();
    this.lastSnapshot = this.validateSnapshot(snapshot);
    this.running = true;
    return this.snapshot();
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    identity?: KernelRequestIdentity,
    _timeoutMs?: number,
  ): Promise<T> {
    if (!this.running) throw new Error(`Kernel ${this.kernelId} is not running`);
    const runIdentity = (): KernelRunIdentity => ({
      ...requireIdentity(identity),
      kernelId: this.kernelId,
      generation: this.generation,
    } as KernelRunIdentity);
    switch (method) {
      case 'runtime.health': {
        const snapshot = await this.health();
        return { ready: snapshot.state === 'ready', snapshot } as T;
      }
      case 'runtime.shutdown':
        await this.stop();
        return { accepted: true } as T;
      case 'session.prompt': {
        const body = (params ?? {}) as Omit<KernelRunRequest, keyof KernelRunIdentity>;
        return await this.launch.driver.execute({ ...body, ...runIdentity() }) as T;
      }
      case 'session.cancel':
        return await this.launch.driver.cancel(runIdentity()) as T;
      case 'session.configure':
        await this.launch.driver.updateRunConfiguration({
          ...((params ?? {}) as Omit<KernelRunConfiguration, keyof KernelRunIdentity>),
          ...runIdentity(),
        });
        return undefined as T;
      case 'session.permission.resolve': {
        const body = (params ?? {}) as {
          requestId: string;
          decision: 'allow-once' | 'reject-once';
          optionId?: string;
          answer?: string;
        };
        await this.launch.driver.resolvePermission({ ...body, ...runIdentity() });
        return undefined as T;
      }
      case 'control.diagnostics':
        return await this.launch.driver.control.diagnostics() as T;
      default:
        return await this.dispatchControl<T>(method, params);
    }
  }

  async health(): Promise<KernelRuntimeSnapshot> {
    if (!this.running) throw new Error(`Kernel ${this.kernelId} is not running`);
    this.lastSnapshot = this.validateSnapshot(await this.launch.driver.health());
    return this.snapshot();
  }

  async stop(): Promise<void> {
    if (!this.running && !this.lastSnapshot) return;
    await this.launch.driver.stop();
    this.running = false;
    this.lastSnapshot = {
      ...this.lastSnapshot,
      kernelId: this.kernelId,
      generation: this.generation,
      state: 'stopped',
      pid: undefined,
    } as KernelRuntimeSnapshot;
  }

  async forceTerminate(): Promise<void> {
    const driver = this.launch.driver as ForceTerminableDriver;
    if (driver.forceTerminate) await driver.forceTerminate();
    else await driver.stop();
    this.running = false;
    if (this.lastSnapshot) this.lastSnapshot = { ...this.lastSnapshot, state: 'stopped', pid: undefined };
  }

  snapshot(): KernelRuntimeSnapshot {
    return this.lastSnapshot ?? {
      kernelId: this.kernelId,
      state: this.running ? 'starting' : 'stopped',
      generation: this.generation,
      artifactVersion: this.artifactVersion,
      ownership: 'clawx-owned',
      runtimeTransport: 'in-process-driver',
      diagnostics: [],
    };
  }

  private validateSnapshot(snapshot: KernelRuntimeSnapshot): KernelRuntimeSnapshot {
    if (snapshot.kernelId !== this.kernelId || snapshot.generation !== this.generation) {
      throw new Error('Kernel driver returned a snapshot for another identity or generation');
    }
    if (
      this.artifactVersion
      && snapshot.artifactVersion
      && snapshot.artifactVersion !== this.artifactVersion
    ) {
      throw new Error('Kernel driver returned a mutable or unexpected artifact version');
    }
    return {
      ...snapshot,
      artifactVersion: this.artifactVersion ?? snapshot.artifactVersion,
      ownership: snapshot.ownership ?? 'clawx-owned',
      runtimeTransport: 'in-process-driver',
    };
  }

  private assertEventIdentity(event: KernelEventEnvelopeV1): void {
    if (event.kernelId !== this.kernelId || event.generation !== this.generation) {
      throw new Error('Kernel driver emitted an event outside its authenticated generation');
    }
  }

  private async dispatchControl<T>(method: string, params: unknown): Promise<T> {
    if (method === 'control.providers.default.set') {
      const body = (params ?? {}) as { accountId?: string; modelId?: string; operationId?: string };
      const setDefault = this.launch.driver.control.providers.setDefault;
      if (!setDefault || !body.accountId) throw new Error('Kernel Provider default projection is unsupported or incomplete');
      await setDefault(
        { accountId: body.accountId, ...(body.modelId ? { modelId: body.modelId } : {}) },
        body.operationId ?? '',
      );
      return undefined as T;
    }
    const match = /^control\.(agents|providers|skills|cron)\.(list|upsert|remove)$/.exec(method);
    if (!match) throw new Error(`Unsupported in-process kernel method: ${method}`);
    const controller = this.launch.driver.control[
      match[1] as 'agents' | 'providers' | 'skills' | 'cron'
    ] as unknown as CanonicalEntityController<{ id: string }>;
    if (match[2] === 'list') return await controller.list() as T;
    const body = (params ?? {}) as { entity?: { id: string }; id?: string; operationId?: string };
    if (match[2] === 'upsert') {
      if (!body.entity) throw new Error('Kernel control upsert entity is required');
      return await controller.upsert(body.entity, body.operationId ?? '') as T;
    }
    await controller.remove(body.id ?? '', body.operationId ?? '');
    return undefined as T;
  }

  emitDiagnostic(message: string): void {
    this.emit('diagnostic', {
      kernelId: this.kernelId,
      generation: this.generation,
      stream: 'protocol',
      message,
    } satisfies KernelProcessDiagnostic);
  }
}
