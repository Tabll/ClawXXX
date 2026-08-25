import type { KernelCapabilities, KernelGeneration, KernelId } from './contracts';

export const KERNEL_STDIO_PROTOCOL = 'clawx.kernel-stdio/v1' as const;

export type KernelRequestIdentity = {
  conversationId: string;
  turnId: string;
  runId: string;
};

export type KernelStdioRequest = {
  protocol: typeof KERNEL_STDIO_PROTOCOL;
  type: 'request';
  requestId: string;
  kernelId: KernelId;
  generation: KernelGeneration;
  method: string;
  identity?: KernelRequestIdentity;
  params?: unknown;
};

export type KernelStdioReady = {
  protocol: typeof KERNEL_STDIO_PROTOCOL;
  type: 'ready';
  kernelId: KernelId;
  generation: KernelGeneration;
  pid: number;
  version: string;
  capabilities: KernelCapabilities;
  startupDurationMs?: number;
  rssBytes?: number;
};

export type KernelStdioResponse = {
  protocol: typeof KERNEL_STDIO_PROTOCOL;
  type: 'response';
  requestId: string;
  kernelId: KernelId;
  generation: KernelGeneration;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

export type KernelStdioEvent = {
  protocol: typeof KERNEL_STDIO_PROTOCOL;
  type: 'event';
  kernelId: KernelId;
  generation: KernelGeneration;
  identity: KernelRequestIdentity;
  eventSeq: number;
  /** Stable runtime-native event identity used to detect replay conflicts. */
  nativeEventId?: string;
  event: { kind: string; payload?: unknown };
};

/** Runtime-to-Main RPC. Only explicitly registered Main handlers may answer. */
export type KernelStdioHostRequest = {
  protocol: typeof KERNEL_STDIO_PROTOCOL;
  type: 'host-request';
  requestId: string;
  kernelId: KernelId;
  generation: KernelGeneration;
  method: string;
  params?: unknown;
};

/** Main-to-runtime response; credential values may exist only in this live frame. */
export type KernelStdioHostResponse = {
  protocol: typeof KERNEL_STDIO_PROTOCOL;
  type: 'host-response';
  requestId: string;
  kernelId: KernelId;
  generation: KernelGeneration;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

export type KernelStdioMessage = KernelStdioReady | KernelStdioResponse | KernelStdioEvent | KernelStdioHostRequest;

export function isKernelStdioMessage(value: unknown): value is KernelStdioMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.protocol === KERNEL_STDIO_PROTOCOL
    && typeof candidate.type === 'string'
    && typeof candidate.kernelId === 'string'
    && Number.isSafeInteger(candidate.generation)
    && (candidate.type === 'ready'
      || candidate.type === 'response'
      || candidate.type === 'event'
      || candidate.type === 'host-request');
}
