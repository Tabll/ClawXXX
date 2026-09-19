// @vitest-environment node
import { request } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { HostToolBroker } from '@electron/kernels/host-tool-broker';
const brokers: HostToolBroker[] = [];
afterEach(async () => { for (const broker of brokers.splice(0)) await broker.close(); });
function fixture() { const broker = new HostToolBroker(); brokers.push(broker); return broker; }
it('requires a private Run capability, rejects browser origins and revokes immediately', async () => {
  const broker = fixture(); const invoke = vi.fn(async request => request.args);
  const { grant, revoke } = await broker.issue(invoke);
  const send = (authorization: string, origin?: string, body = JSON.stringify({ tool: 'clawx_agent', args: { action: 'list' } })) => fetch(grant.url, {
    method: 'POST', headers: { Authorization: authorization, ...(origin ? { Origin: origin } : {}) }, body,
  });
  expect((await send('Bearer invalid')).status).toBe(403);
  expect((await send(grant.token)).status).toBe(403);
  expect((await send(`Bearer ${grant.token}`, 'https://example.test')).status).toBe(403);
  expect((await send(`Bearer ${grant.token}`, undefined, JSON.stringify({ tool: 'clawx_agent', args: { text: 'x'.repeat(140_000) } }))).status).toBe(400);
  const response = await send(`Bearer ${grant.token}`); expect(await response.json()).toEqual({ result: { action: 'list' } });
  revoke(); expect((await send(`Bearer ${grant.token}`)).status).toBe(403);
  expect(invoke).toHaveBeenCalledTimes(1);
});
it('preserves UTF-8 across split network chunks and redacts handler failures', async () => {
  const broker = fixture(); const { grant } = await broker.issue(async input => input.args);
  const body = Buffer.from(JSON.stringify({ tool: 'clawx_agent', args: { prompt: '中文🦀' } }));
  const split = body.indexOf(Buffer.from('中')) + 1;
  const result = await new Promise<string>((resolve, reject) => {
    const req = request(grant.url, { method: 'POST', headers: { Authorization: `Bearer ${grant.token}` } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve(data));
    });
    req.on('error', reject); req.write(body.subarray(0, split)); setImmediate(() => req.end(body.subarray(split)));
  });
  expect(JSON.parse(result).result.prompt).toBe('中文🦀');
  const bad = await broker.issue(async () => { throw new Error('secret-token-and-private-path'); });
  const failure = await fetch(bad.grant.url, { method: 'POST', headers: { Authorization: `Bearer ${bad.grant.token}` }, body: JSON.stringify({ tool: 'clawx_agent', args: {} }) });
  expect(await failure.text()).not.toContain('secret-token');
});
it('cancels pending operations and cannot grant new capabilities after close', async () => {
  const broker = fixture(); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const { grant, revoke } = await broker.issue(async (_request, signal) => {
    entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  });
  const response = fetch(grant.url, { method: 'POST', headers: { Authorization: `Bearer ${grant.token}` }, body: JSON.stringify({ tool: 'clawx_agent', args: {} }) });
  await started; revoke(); expect((await response).status).toBe(400);
  await broker.close(); await expect(broker.issue(async () => undefined)).rejects.toThrow('closed');
});
