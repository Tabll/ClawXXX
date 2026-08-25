import type { KernelGeneration, KernelId } from '../kernels/contracts';

export const DATA_SERVICE_RPC_PROTOCOL = 'clawx.data-service-rpc/v1' as const;

export type DataServiceRpcScope =
  | { role: 'main' }
  | { role: 'kernel'; kernelId: KernelId; generation: KernelGeneration };

export type DataServiceRpcRequest = {
  protocol: typeof DATA_SERVICE_RPC_PROTOCOL;
  type: 'request';
  requestId: string;
  method: 'service.connect' | 'service.disconnect' | 'service.shutdown' | 'client.call';
  clientId?: string;
  params?: unknown;
};

export type DataServiceRpcReady = {
  protocol: typeof DATA_SERVICE_RPC_PROTOCOL;
  type: 'ready';
  schemaVersion: number;
  pid: number;
};

export type DataServiceRpcResponse = {
  protocol: typeof DATA_SERVICE_RPC_PROTOCOL;
  type: 'response';
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

export type DataServiceRpcMessage = DataServiceRpcReady | DataServiceRpcResponse;
