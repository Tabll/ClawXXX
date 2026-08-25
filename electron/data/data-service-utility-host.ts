import { randomUUID } from 'node:crypto';
import {
  DATA_SERVICE_RPC_PROTOCOL,
  type DataServiceRpcMessage,
  type DataServiceRpcRequest,
  type DataServiceRpcScope,
} from '@shared/data/rpc';

export interface DataServiceProcessTransport {
  onMessage(listener: (message: DataServiceRpcMessage) => void): () => void;
  onExit(listener: (error?: Error) => void): () => void;
  diagnostics?(): string;
  start(): void;
  postMessage(message: DataServiceRpcRequest): void;
  close(): void;
}

export type DataServiceTransportFactory = () => DataServiceProcessTransport;

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
};

export class ClawXDataServiceUtilityHost {
  private transport?: DataServiceProcessTransport;
  private ready = false;
  private readonly pending = new Map<string, Pending>();
  private readonly scopes = new Map<string, DataServiceRpcScope>();
  private recovery?: Promise<void>;
  private closing = false;
  private restartAttempts = 0;

  constructor(
    private readonly createTransport: DataServiceTransportFactory,
    private readonly options: { startupTimeoutMs?: number; requestTimeoutMs?: number; maxRestarts?: number } = {},
  ) {}

  async start(): Promise<void> {
    if (this.transport && this.ready) return;
    this.recovery ??= this.spawnAndReconnect();
    try {
      await this.recovery;
    } finally {
      this.recovery = undefined;
    }
  }

  async connect(scope: DataServiceRpcScope): Promise<RemoteDataServiceClient> {
    await this.ensureReady();
    const clientId = randomUUID();
    await this.request('service.connect', scope, clientId);
    this.scopes.set(clientId, scope);
    return new RemoteDataServiceClient(this, clientId);
  }

  async disconnect(clientId: string): Promise<void> {
    this.scopes.delete(clientId);
    if (!this.transport) return;
    await this.request('service.disconnect', undefined, clientId).catch(() => undefined);
  }

  call<T>(clientId: string, method: string, args: unknown[]): Promise<T> {
    if (!this.scopes.has(clientId)) return Promise.reject(new Error('DataService client is disconnected'));
    return this.ensureReady().then(() => this.request('client.call', { method, args }, clientId) as Promise<T>);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.scopes.clear();
    if (this.transport) await this.request('service.shutdown').catch(() => undefined);
    this.transport?.close();
    this.transport = undefined;
    this.ready = false;
    this.rejectPending(new Error('DataService host closed'));
  }

  private async ensureReady(): Promise<void> {
    if (this.transport && this.ready) return;
    if (!this.recovery) this.recovery = this.spawnAndReconnect();
    try {
      await this.recovery;
    } finally {
      this.recovery = undefined;
    }
  }

  private async spawnAndReconnect(): Promise<void> {
    if (this.closing) throw new Error('DataService host is closing');
    const transport = this.createTransport();
    this.transport = transport;
    this.ready = false;
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribeExit = () => {};
      const cleanup = () => {
        clearTimeout(timeout);
        unsubscribeMessage();
        unsubscribeExit();
      };
      const diagnostics = () => {
        const detail = transport.diagnostics?.().trim();
        return detail ? `\n${detail}` : '';
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        transport.close();
        reject(new Error(`DataService utility process startup timed out${diagnostics()}`));
      }, this.options.startupTimeoutMs ?? 10_000);
      const unsubscribeMessage = transport.onMessage(message => {
        if (message.protocol !== DATA_SERVICE_RPC_PROTOCOL) return;
        if (message.type === 'ready') {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        }
      });
      unsubscribeExit = transport.onExit(error => {
        if (settled) return;
        settled = true;
        cleanup();
        const message = error?.message ?? 'DataService exited before ready';
        reject(new Error(`${message}${diagnostics()}`));
      });
    });
    transport.onMessage(message => this.handleMessage(message));
    transport.onExit(error => this.handleExit(transport, error));
    transport.start();
    await ready;
    this.ready = true;
    for (const [clientId, scope] of this.scopes) {
      await this.request('service.connect', scope, clientId);
    }
    this.restartAttempts = 0;
  }

  private request(
    method: DataServiceRpcRequest['method'],
    params?: unknown,
    clientId?: string,
  ): Promise<unknown> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new Error('DataService utility process is unavailable'));
    const requestId = randomUUID();
    const message: DataServiceRpcRequest = {
      protocol: DATA_SERVICE_RPC_PROTOCOL,
      type: 'request',
      requestId,
      method,
      ...(clientId ? { clientId } : {}),
      ...(params === undefined ? {} : { params }),
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`DataService request timed out: ${method}`));
      }, this.options.requestTimeoutMs ?? 15_000);
      this.pending.set(requestId, { resolve, reject, timeout });
      try {
        transport.postMessage(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(message: DataServiceRpcMessage): void {
    if (message.protocol !== DATA_SERVICE_RPC_PROTOCOL || message.type !== 'response') return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else {
      const error = new Error(message.error?.message ?? 'DataService request failed') as Error & { code?: string };
      error.code = message.error?.code;
      pending.reject(error);
    }
  }

  private handleExit(transport: DataServiceProcessTransport, error?: Error): void {
    if (this.transport !== transport) return;
    this.transport = undefined;
    this.ready = false;
    this.rejectPending(error ?? new Error('DataService utility process exited'));
    if (this.closing) return;
    this.restartAttempts += 1;
    if (this.restartAttempts > (this.options.maxRestarts ?? 3)) return;
    this.recovery ??= this.spawnAndReconnect().finally(() => { this.recovery = undefined; });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class RemoteDataServiceClient {
  constructor(
    private readonly host: ClawXDataServiceUtilityHost,
    readonly clientId: string,
  ) {}

  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.host.call<T>(this.clientId, method, args);
  }

  disconnect(): Promise<void> {
    return this.host.disconnect(this.clientId);
  }
}
