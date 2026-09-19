import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { HostToolGrant, HostToolRequest } from '@shared/kernels/host-tools';

type Lease = { controller: AbortController; active: number; invoke(request: HostToolRequest, signal: AbortSignal): Promise<unknown> };

/** Main-only capabilities scoped to a single admitted Run, with immediate revocation. */
export class HostToolBroker {
  private server?: Server;
  private url?: string;
  private starting?: Promise<void>;
  private closed = false;
  private readonly leases = new Map<string, Lease>();
  async issue(invoke: Lease['invoke']): Promise<{ grant: HostToolGrant; revoke(): void }> {
    if (this.closed) throw new Error('Host tool broker closed');
    await this.start();
    if (this.closed) throw new Error('Host tool broker closed');
    if (this.leases.size >= 256) throw new Error('Host tool capacity exceeded');
    const token = randomBytes(32).toString('base64url');
    const controller = new AbortController();
    this.leases.set(token, { controller, active: 0, invoke });
    return { grant: { url: this.url!, token }, revoke: () => { controller.abort(); this.leases.delete(token); } };
  }
  private async start(): Promise<void> {
    if (this.url) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const server = createServer(async (request, response) => {
        const send = (status: number, value: unknown) => {
          if (response.destroyed) return;
          const body = JSON.stringify(value);
          response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' });
          response.end(body);
        };
        const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
        const lease = this.leases.get(token);
        if (request.method !== 'POST' || request.url !== '/v1/run/tool' || request.headers.origin
          || !lease || lease.controller.signal.aborted || lease.active >= 8) { send(403, { error: 'Run tool capability unavailable' }); return; }
        lease.active++;
        const controller = new AbortController();
        const abort = () => controller.abort();
        const timer = setTimeout(abort, 370_000); timer.unref();
        lease.controller.signal.addEventListener('abort', abort, { once: true });
        response.once('close', abort);
        try {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of request) {
            const bytes = Buffer.from(chunk); size += bytes.length;
            if (size > 128 * 1024) throw new Error('Tool request exceeds limit');
            chunks.push(bytes);
          }
          const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          const parsed = JSON.parse(body) as HostToolRequest;
          if (!['clawx_dingtalk', 'clawx_agent', 'clawx_computer'].includes(parsed.tool)
            || !parsed.args || typeof parsed.args !== 'object' || Array.isArray(parsed.args)) throw new Error('Invalid tool request');
          controller.signal.throwIfAborted();
          const value = await lease.invoke(parsed, controller.signal);
          controller.signal.throwIfAborted();
          if (Buffer.byteLength(JSON.stringify(value)) > 12 * 1024 * 1024) throw new Error('Tool output exceeds limit');
          send(200, { result: value });
        } catch {
          // Never return native errors, private metadata, credentials or paths.
          send(400, { error: controller.signal.aborted ? 'Run tool cancelled' : 'Run tool failed or permission denied' });
        } finally { clearTimeout(timer); lease.active--; lease.controller.signal.removeEventListener('abort', abort); response.off('close', abort); }
      });
      server.requestTimeout = 20_000; server.headersTimeout = 10_000;
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
      this.server = server;
      this.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/run/tool`;
    })();
    try { await this.starting; } finally { this.starting = undefined; }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.starting;
    for (const lease of this.leases.values()) lease.controller.abort();
    this.leases.clear();
    const server = this.server; this.server = undefined; this.url = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}
