import type {
  KernelControlPlane,
  KernelDefinition,
  KernelDriver,
  KernelDriverHost,
  KernelPermissionResolution,
  KernelRunAcceptance,
  KernelRunConfiguration,
  KernelRunIdentity,
  KernelRunRequest,
  KernelRuntimeSnapshot,
} from '@shared/kernels/contracts';
import type { OpenClawRuntimeLocation } from './runtime-location';
import {
  configureOpenClawRuntimeLocation,
  ensureManagedOpenClawDataRoots,
} from './runtime-location';

export const OPENCLAW_KERNEL_DEFINITION: KernelDefinition = {
  id: 'openclaw',
  displayName: 'OpenClaw',
  contractVersion: 1,
  storeProtocolRange: '1',
  capabilities: {
    chat: true,
    cancel: true,
    permissions: true,
    resume: true,
    configuration: true,
    agents: true,
    providers: true,
    skills: true,
    channels: true,
    cron: true,
    usage: true,
    checkpointCodecs: ['clawx.openclaw.session-manager/v1'],
  },
};

export type OpenClawGatewayAdapter = {
  start(): Promise<void>;
  stop(): Promise<void>;
  forceTerminateOwnedProcessForQuit?(): Promise<unknown>;
  getStatus(): {
    state: string;
    pid?: number;
    version?: string;
    error?: string;
    uptime?: number;
    gatewayReady?: boolean;
  };
  getDiagnostics?(): unknown;
  checkHealth?(options?: { probe?: boolean }): Promise<{ ok: boolean; error?: string; uptime?: number; version?: string }>;
};

export type OpenClawChatAdapter = {
  initialize?(input: {
    host: KernelDriverHost;
    generation: number;
    runtime: OpenClawRuntimeLocation;
  }): Promise<void>;
  execute(input: KernelRunRequest): Promise<KernelRunAcceptance>;
  cancel(input: KernelRunIdentity): Promise<{ acknowledged: boolean }>;
  resolvePermission(input: KernelPermissionResolution): Promise<void>;
  updateRunConfiguration(input: KernelRunConfiguration): Promise<void>;
  stop?(): Promise<void>;
};

export type OpenClawDriverLifecycleHooks = {
  beforeStart?(input: { runtime: OpenClawRuntimeLocation; generation: number }): Promise<void>;
  afterStart?(input: { runtime: OpenClawRuntimeLocation; generation: number }): Promise<void>;
  beforeStop?(input: { runtime: OpenClawRuntimeLocation; generation: number }): Promise<void>;
  afterStop?(input: { runtime: OpenClawRuntimeLocation; generation: number }): Promise<void>;
};

export type OpenClawKernelDriverOptions = {
  generation: number;
  runtime: OpenClawRuntimeLocation;
  gateway: OpenClawGatewayAdapter;
  chat: OpenClawChatAdapter;
  control: KernelControlPlane;
  hooks?: OpenClawDriverLifecycleHooks;
  now?: () => Date;
};

function diagnosticsFor(value: unknown): string[] {
  if (!value) return [];
  try {
    return [JSON.stringify(value)];
  } catch {
    return [String(value)];
  }
}

export class OpenClawKernelDriver implements KernelDriver {
  readonly definition = OPENCLAW_KERNEL_DEFINITION;
  readonly control: KernelControlPlane;
  private host?: KernelDriverHost;
  private initialized = false;
  private running = false;
  private startedAt?: string;
  private startupDurationMs?: number;
  private lastHealthAt?: string;

  constructor(private readonly options: OpenClawKernelDriverOptions) {
    if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
      throw new Error('OpenClaw generation must be a positive safe integer');
    }
    if (options.runtime.kernelId !== 'openclaw' || !options.runtime.managed) {
      throw new Error('OpenClawKernelDriver requires a managed OpenClaw runtime');
    }
    this.control = options.control;
  }

  async initialize(host: KernelDriverHost): Promise<void> {
    if (this.initialized) throw new Error('OpenClawKernelDriver is already initialized');
    if (host.store.nativeHistoryFallback !== false) {
      throw new Error('Managed OpenClaw forbids native history fallback');
    }
    configureOpenClawRuntimeLocation(this.options.runtime);
    this.host = host;
    await this.options.chat.initialize?.({
      host,
      generation: this.options.generation,
      runtime: this.options.runtime,
    });
    this.initialized = true;
  }

  async start(): Promise<KernelRuntimeSnapshot> {
    this.requireInitialized();
    if (this.running) return this.snapshot('ready');
    ensureManagedOpenClawDataRoots(this.options.runtime);
    const started = Date.now();
    await this.options.hooks?.beforeStart?.({
      runtime: this.options.runtime,
      generation: this.options.generation,
    });
    try {
      await this.options.gateway.start();
      const status = this.options.gateway.getStatus();
      if (status.state !== 'running') {
        throw new Error(status.error || `OpenClaw Gateway did not reach running state (${status.state})`);
      }
      this.running = true;
      this.startedAt = this.now().toISOString();
      this.startupDurationMs = Date.now() - started;
      await this.options.hooks?.afterStart?.({
        runtime: this.options.runtime,
        generation: this.options.generation,
      });
      return this.snapshot('ready');
    } catch (error) {
      await this.options.gateway.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.initialized || !this.running) return;
    await this.options.hooks?.beforeStop?.({
      runtime: this.options.runtime,
      generation: this.options.generation,
    });
    await Promise.allSettled([
      this.options.chat.stop?.(),
      this.options.gateway.stop(),
    ]);
    this.running = false;
    await this.options.hooks?.afterStop?.({
      runtime: this.options.runtime,
      generation: this.options.generation,
    });
  }

  async forceTerminate(): Promise<void> {
    await this.options.chat.stop?.().catch(() => undefined);
    if (this.options.gateway.forceTerminateOwnedProcessForQuit) {
      await this.options.gateway.forceTerminateOwnedProcessForQuit();
    } else {
      await this.options.gateway.stop();
    }
    this.running = false;
  }

  async health(): Promise<KernelRuntimeSnapshot> {
    this.requireReady();
    if (this.options.gateway.checkHealth) {
      const result = await this.options.gateway.checkHealth({ probe: true });
      if (!result.ok) throw new Error(result.error || 'OpenClaw Gateway health check failed');
    } else if (this.options.gateway.getStatus().state !== 'running') {
      throw new Error('OpenClaw Gateway is not running');
    }
    this.lastHealthAt = this.now().toISOString();
    return this.snapshot('ready');
  }

  execute(input: KernelRunRequest): Promise<KernelRunAcceptance> {
    this.assertIdentity(input);
    this.requireReady();
    return this.options.chat.execute(input);
  }

  cancel(input: KernelRunIdentity): Promise<{ acknowledged: boolean }> {
    this.assertIdentity(input);
    this.requireReady();
    return this.options.chat.cancel(input);
  }

  resolvePermission(input: KernelPermissionResolution): Promise<void> {
    this.assertIdentity(input);
    this.requireReady();
    return this.options.chat.resolvePermission(input);
  }

  updateRunConfiguration(input: KernelRunConfiguration): Promise<void> {
    this.assertIdentity(input);
    this.requireReady();
    return this.options.chat.updateRunConfiguration(input);
  }

  private snapshot(state: KernelRuntimeSnapshot['state']): KernelRuntimeSnapshot {
    const status = this.options.gateway.getStatus();
    return {
      kernelId: 'openclaw',
      state,
      generation: this.options.generation,
      version: status.version,
      artifactVersion: this.options.runtime.artifactVersion,
      pid: state === 'ready' ? status.pid : undefined,
      ownership: 'clawx-owned',
      startedAt: state === 'ready' ? this.startedAt : undefined,
      lastHealthAt: this.lastHealthAt,
      startupDurationMs: this.startupDurationMs,
      capabilities: this.definition.capabilities,
      diagnostics: diagnosticsFor(this.options.gateway.getDiagnostics?.()),
      lastError: status.error,
    };
  }

  private assertIdentity(input: KernelRunIdentity): void {
    if (input.kernelId !== 'openclaw' || input.generation !== this.options.generation) {
      throw new Error('OpenClaw request is outside this driver generation');
    }
  }

  private requireInitialized(): KernelDriverHost {
    if (!this.initialized || !this.host) throw new Error('OpenClawKernelDriver is not initialized');
    return this.host;
  }

  private requireReady(): void {
    this.requireInitialized();
    if (!this.running) throw new Error('OpenClawKernelDriver is not running');
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
