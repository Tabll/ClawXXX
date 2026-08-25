import { utilityProcess, type UtilityProcess } from 'electron';
import type { DataServiceRpcMessage, DataServiceRpcRequest } from '@shared/data/rpc';
import type { DataServiceProcessTransport } from './data-service-utility-host';

export class ElectronDataServiceTransport implements DataServiceProcessTransport {
  private static readonly MAX_DIAGNOSTIC_BYTES = 32 * 1024;
  private child?: UtilityProcess;
  private readonly messageListeners = new Set<(message: DataServiceRpcMessage) => void>();
  private readonly exitListeners = new Set<(error?: Error) => void>();
  private stdoutTail = '';
  private stderrTail = '';

  constructor(
    private readonly entryPath: string,
    private readonly databasePath: string,
    private readonly blobRoot: string,
  ) {}

  onMessage(listener: (message: DataServiceRpcMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onExit(listener: (error?: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  diagnostics(): string {
    return [
      this.stdoutTail ? `DataService stdout:\n${this.stdoutTail}` : '',
      this.stderrTail ? `DataService stderr:\n${this.stderrTail}` : '',
    ].filter(Boolean).join('\n');
  }

  start(): void {
    if (this.child) throw new Error('DataService utility process already started');
    const child = utilityProcess.fork(this.entryPath, [], {
      serviceName: 'ClawX DataService',
      stdio: 'pipe',
      env: {
        ...process.env,
        CLAWX_DATA_DATABASE_PATH: this.databasePath,
        CLAWX_DATA_BLOB_ROOT: this.blobRoot,
      },
    });
    this.child = child;
    child.stdout?.on('data', chunk => {
      this.stdoutTail = this.appendDiagnosticTail(this.stdoutTail, chunk);
    });
    child.stderr?.on('data', chunk => {
      this.stderrTail = this.appendDiagnosticTail(this.stderrTail, chunk);
    });
    child.on('message', message => {
      for (const listener of this.messageListeners) listener(message as DataServiceRpcMessage);
    });
    child.once('exit', code => {
      this.child = undefined;
      const diagnostics = this.diagnostics();
      const error = code === 0
        ? undefined
        : new Error(`DataService utility process exited with code ${code}${diagnostics ? `\n${diagnostics}` : ''}`);
      for (const listener of this.exitListeners) listener(error);
    });
    child.once('error', error => {
      const normalized = new Error(String(error));
      for (const listener of this.exitListeners) listener(normalized);
    });
  }

  postMessage(message: DataServiceRpcRequest): void {
    if (!this.child) throw new Error('DataService utility process is not started');
    this.child.postMessage(message);
  }

  close(): void {
    this.child?.kill();
    this.child = undefined;
  }

  private appendDiagnosticTail(current: string, chunk: unknown): string {
    const next = current + String(chunk);
    return next.length <= ElectronDataServiceTransport.MAX_DIAGNOSTIC_BYTES
      ? next
      : next.slice(-ElectronDataServiceTransport.MAX_DIAGNOSTIC_BYTES);
  }
}
