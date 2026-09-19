// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerUseService, type ComputerNativeClient } from '@electron/services/computer-use';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function fixture() {
  const state = { generation: 1, granted: true, available: true };
  const client: ComputerNativeClient = {
    listToolsJson: vi.fn(async () => JSON.stringify({ tools: [{ name: 'click' }, { name: 'start_session' }, { name: 'escalate_session' }] })),
    startSession: vi.fn(async () => ({})), endSession: vi.fn(async () => ({})),
    callTool: vi.fn(async () => ({ text: 'done', images: [], isError: false })),
  };
  const host = { start: vi.fn(async () => client), stop: vi.fn(async () => undefined) };
  const save = vi.fn(async () => undefined);
  const createHost = vi.fn(async () => host);
  const requestPermissions = vi.fn(async () => undefined);
  const service = new ComputerUseService({ selected: null, supported: true,
    permissions: () => ({ accessibility: state.granted, screenRecording: state.granted }),
    generation: () => state.generation,
    resolve: async () => state.available ? { key: 'verified-payload', binaryPath: '/fixture/cua', sdkRoot: '/fixture/sdk' } : undefined,
    createHost, save, requestPermissions,
  });
  cleanups.push(() => service.close());
  const run = { runId: 'run-one', kernelId: 'openclaw', generation: 1 };
  const call = (args: Record<string, unknown> = { action: 'call', name: 'click', parameters: { x: 10, y: 20 } }, signal = new AbortController().signal) => service.execute(run, args, signal);
  return { service, state, run, call, host, client, save, createHost, requestPermissions };
}
describe('Main-owned Computer Use', () => {
  it('defaults off, requires OS permission and rejects the other kernel or stale generation', async () => {
    const f = fixture();
    await expect(f.call()).rejects.toThrow();
    await f.service.select('openclaw'); f.state.granted = false;
    f.state.available = false;
    await expect(f.service.status()).resolves.toMatchObject({ state: 'unavailable' });
    f.state.available = true;
    await expect(f.service.status()).resolves.toMatchObject({ state: 'permissions' });
    await expect(f.call()).rejects.toThrow('permission');
    expect(f.createHost).not.toHaveBeenCalled(); expect(f.requestPermissions).not.toHaveBeenCalled();
    f.state.granted = true;
    await expect(f.service.execute({ ...f.run, kernelId: 'deepseek-harness' }, { action: 'list' }, new AbortController().signal)).rejects.toThrow();
    f.state.generation = 2; await expect(f.call()).rejects.toThrow();
  });
  it('exposes only approved actions and binds private native sessions to canonical Runs', async () => {
    const f = fixture(); await f.service.select('openclaw');
    await expect(f.call({ action: 'list' })).resolves.toEqual([{ name: 'click' }]);
    await expect(f.call({ action: 'call', name: 'escalate_session' })).rejects.toThrow();
    await expect(f.call({ action: 'call', name: 'click', parameters: { session: 'foreign' } })).rejects.toThrow();
    for (const field of ['screenshotOutFile', 'screenshot_out_file', 'filePath', 'imagePath']) {
      await expect(f.call({ action: 'call', name: 'get_desktop_state', parameters: { [field]: '/outside/workspace' } })).rejects.toThrow();
    }
    await f.call(); await f.call();
    expect(f.client.startSession).toHaveBeenCalledTimes(1);
    const nativeSession = vi.mocked(f.client.startSession).mock.calls[0][0].session;
    expect(nativeSession).toMatch(/^clawx-/); expect(nativeSession).not.toBe(f.run.runId);
    expect(JSON.parse(vi.mocked(f.client.callTool).mock.calls[0][1]).session).toBe(nativeSession);
    await f.service.endRun(f.run.runId); expect(f.client.endSession).toHaveBeenCalledWith({ session: nativeSession }, expect.anything());
  });
  it('aborts in-flight work and stops the old daemon before switching kernels', async () => {
    const f = fixture(); await f.service.select('openclaw');
    let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(f.client.callTool).mockImplementation(async (_name, _args, options) => { started(); return new Promise((_resolve, reject) => options!.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); });
    const action = f.call(); const rejected = expect(action).rejects.toThrow('aborted'); await entered;
    await expect(f.call()).rejects.toThrow('busy');
    await f.service.select('deepseek-harness'); await rejected;
    expect(f.host.stop).toHaveBeenCalledTimes(1);
    expect(await f.service.status()).toMatchObject({ kernelId: 'deepseek-harness', state: 'ready' });
    await expect(f.call()).rejects.toThrow();
  });
  it.each(['permission', 'generation', 'payload'])('stops on %s revocation', async reason => {
    const f = fixture(); await f.service.select('openclaw'); await f.call();
    if (reason === 'permission') f.state.granted = false;
    if (reason === 'generation') f.state.generation++;
    if (reason === 'payload') f.state.available = false;
    await f.service.status(); expect(f.host.stop).toHaveBeenCalledTimes(1);
    expect(f.client.callTool).toHaveBeenCalledTimes(1);
  });
  it('does not resurrect a driver that finishes starting after disable', async () => {
    const f = fixture(); await f.service.select('openclaw');
    let release!: () => void; let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(f.host.start).mockImplementation(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return f.client; });
    const action = f.call(); const rejected = expect(action).rejects.toThrow(); await entered;
    await f.service.select(null); release(); await rejected;
    expect(f.host.stop).toHaveBeenCalledTimes(1); expect(f.client.callTool).not.toHaveBeenCalled();
    expect(await f.service.status()).toMatchObject({ kernelId: null, state: 'disabled' });
  });

  it('still stops native execution if saving the disabled preference fails', async () => {
    const f = fixture(); await f.service.select('openclaw'); await f.call();
    f.save.mockRejectedValueOnce(new Error('settings store unavailable'));
    await expect(f.service.select(null)).rejects.toThrow('settings store unavailable');
    expect(f.host.stop).toHaveBeenCalledTimes(1);
    expect(await f.service.status()).toMatchObject({ kernelId: null, state: 'disabled' });
    await expect(f.call()).rejects.toThrow();
  });
  it('returns bounded images as content instead of JSON text and fails closed on invalid bytes', async () => {
    const f = fixture(); await f.service.select('openclaw');
    vi.mocked(f.client.callTool).mockResolvedValueOnce({ text: 'desktop', images: [{ mimeType: 'image/png', dataBase64: 'YWJj' }], isError: false });
    await expect(f.call()).resolves.toEqual({ content: [{ type: 'text', text: 'desktop' }, { type: 'image', mimeType: 'image/png', data: 'YWJj' }], isError: false });
    vi.mocked(f.client.callTool).mockResolvedValueOnce({ text: '', images: [{ mimeType: 'image/png', dataBase64: 'bad encoding' }], isError: false });
    await expect(f.call()).rejects.toThrow('image'); expect(f.host.stop).toHaveBeenCalledTimes(1);
  });
});
