import { randomUUID } from 'node:crypto';
import type { KernelId } from '@shared/kernels/contracts';
import type { ComputerToolResult, ComputerUseStatus } from '@shared/kernels/computer-use';
import type { ComputerRuntime } from '../kernels/computer-use-runtime';

export interface ComputerNativeClient {
  listToolsJson(options?: { signal: AbortSignal }): Promise<string>;
  startSession(input: { session: string }, options?: { signal: AbortSignal }): Promise<unknown>;
  endSession(input: { session: string }, options?: { signal: AbortSignal }): Promise<unknown>;
  callTool(name: string, args: string, options?: { signal: AbortSignal }): Promise<{
    text: string; images: Array<{ mimeType: string; dataBase64: string }>; isError: boolean;
  }>;
}
export interface ComputerNativeHost { start(): Promise<ComputerNativeClient>; stop(): Promise<void>; waitForExit?(): Promise<unknown> }
type Run = { kernelId: KernelId; generation: number; runId: string };
type Dependencies = {
  supported: boolean;
  selected: KernelId | null;
  permissions(): { accessibility: boolean; screenRecording: boolean };
  generation(kernelId: KernelId): number | undefined;
  resolve(kernelId: KernelId): Promise<ComputerRuntime | undefined>;
  createHost(runtime: ComputerRuntime): Promise<ComputerNativeHost>;
  save(kernelId: KernelId | null): Promise<void>;
  requestPermissions(runtime: ComputerRuntime): Promise<void>;
};

// Session lifecycle, grants, daemon control and policy escalation stay in Main.
const ACTIONS = new Set(['get_desktop_state', 'get_screen_size', 'get_cursor_position', 'click', 'move_cursor',
  'drag', 'scroll', 'press_key', 'hotkey', 'type_text', 'clipboard_read', 'clipboard_write', 'invoke_menu',
  'set_window_frame', 'verify_state', 'get_agent_cursor_state', 'set_agent_cursor_enabled', 'set_agent_cursor_motion', 'set_agent_cursor_theme']);
const RESERVED = ['session', 'screenshotOutFile', 'screenshot_out_file', 'imagePath', 'image_path', 'filePath', 'file_path'];

/** One desktop owner across kernels. Native sessions and sockets never leave Main. */
export class ComputerUseService {
  private selected: KernelId | null;
  private epoch = 0;
  private scope = new AbortController();
  private active?: { host: ComputerNativeHost; client?: ComputerNativeClient; runtime: ComputerRuntime; kernelId: KernelId; generation: number };
  private operation?: Promise<unknown>;
  private configuration: Promise<unknown> = Promise.resolve();
  private readonly sessions = new Map<string, string>();
  private failed = false;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly dependencies: Dependencies) {
    this.selected = dependencies.selected;
    this.timer = setInterval(() => { void this.checkLease().catch(() => undefined); }, 2_000);
    this.timer.unref?.();
  }

  async status(): Promise<ComputerUseStatus> {
    await this.checkLease();
    const permissions = this.dependencies.permissions();
    const kernelId = this.selected;
    const available = kernelId && this.dependencies.supported
      && await this.dependencies.resolve(kernelId) && this.dependencies.generation(kernelId) !== undefined;
    const state = !this.dependencies.supported ? 'unsupported' : !kernelId ? 'disabled'
      : !available ? 'unavailable'
      : !permissions.accessibility || !permissions.screenRecording ? 'permissions'
      : this.failed ? 'failed' : this.active?.client ? 'running' : 'ready';
    return { kernelId, supported: this.dependencies.supported, state, ...permissions };
  }

  async select(kernelId: KernelId | null): Promise<ComputerUseStatus> {
    if (this.closed || (kernelId !== null && kernelId !== 'openclaw' && kernelId !== 'deepseek-harness')) throw new Error('Invalid Computer Use selection');
    if (kernelId && !this.dependencies.supported) throw new Error('Computer Use unsupported');
    const epoch = ++this.epoch;
    this.selected = null; this.scope.abort();
    const configure = this.configuration.catch(() => undefined).then(async () => {
      // A failed native stop must not restore a revoked opt-in on app restart.
      try { await this.dependencies.save(null); } finally { await this.stopNative(); }
      if (epoch !== this.epoch || this.closed) return;
      if (kernelId) await this.dependencies.save(kernelId);
      if (epoch !== this.epoch || this.closed) return;
      this.selected = kernelId; this.scope = new AbortController(); this.failed = false;
    });
    this.configuration = configure;
    await configure;
    return this.status();
  }

  async requestPermissions(): Promise<ComputerUseStatus> {
    const kernelId = this.selected;
    if (kernelId && this.dependencies.supported) {
      const runtime = await this.dependencies.resolve(kernelId);
      if (runtime) await this.dependencies.requestPermissions(runtime);
    }
    return this.status();
  }

  async execute(run: Run, args: Record<string, unknown>, signal: AbortSignal): Promise<ComputerToolResult | unknown[]> {
    if (this.operation) throw new Error('Desktop is busy');
    const operation = this.executeOwned(run, args, signal);
    this.operation = operation;
    try { return await operation; } finally { if (this.operation === operation) this.operation = undefined; }
  }

  private async executeOwned(run: Run, args: Record<string, unknown>, signal: AbortSignal): Promise<ComputerToolResult | unknown[]> {
    await this.configuration;
    await this.checkLease();
    const epoch = this.epoch;
    const combined = AbortSignal.any([signal, this.scope.signal, AbortSignal.timeout(60_000)]);
    const assertOwner = () => {
      combined.throwIfAborted();
      if (this.closed || !this.dependencies.supported || this.selected !== run.kernelId || epoch !== this.epoch
        || this.dependencies.generation(run.kernelId) !== run.generation) throw new Error('Computer Use lease unavailable');
      const permissions = this.dependencies.permissions();
      if (!permissions.accessibility || !permissions.screenRecording) throw new Error('Computer Use OS permission missing');
    };
    assertOwner();
    if (args.action !== 'list' && (args.action !== 'call' || typeof args.name !== 'string' || !ACTIONS.has(args.name))) throw new Error('Unsupported desktop action');
    const runtime = await this.dependencies.resolve(run.kernelId);
    assertOwner();
    if (!runtime) throw new Error('Computer Use payload unavailable');
    try {
      if (!this.active) {
        const host = await this.dependencies.createHost(runtime);
        try { assertOwner(); } catch (error) { await host.stop(); throw error; }
        this.active = { host, runtime, kernelId: run.kernelId, generation: run.generation };
        this.active.client = await host.start();
        assertOwner();
        this.failed = false;
        const active = this.active;
        const exited = async () => {
          if (this.active !== active) return;
          this.failed = true; this.scope.abort(); await this.stopNative();
          if (!this.closed && epoch === this.epoch) this.scope = new AbortController();
        };
        void host.waitForExit?.().then(exited, exited).catch(() => undefined);
      }
      const client = this.active.client!;
      if (args.action === 'list') {
        const inventory: unknown = JSON.parse(await client.listToolsJson({ signal: combined }));
        assertOwner();
        const tools = Array.isArray(inventory) ? inventory : (inventory as { tools?: unknown[] })?.tools;
        if (!Array.isArray(tools)) throw new Error('Invalid CUA tool inventory');
        return tools.filter(tool => tool && typeof tool === 'object' && ACTIONS.has((tool as { name: string }).name)).map(tool => {
          const copy = structuredClone(tool) as { inputSchema?: { properties?: Record<string, unknown>; required?: string[] } };
          if (copy.inputSchema?.properties) for (const key of RESERVED) delete copy.inputSchema.properties[key];
          if (copy.inputSchema?.required) copy.inputSchema.required = copy.inputSchema.required.filter(key => !RESERVED.includes(key));
          return copy;
        });
      }
      const parameters = args.parameters ?? {};
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || JSON.stringify(parameters).length > 64_000) throw new Error('Invalid desktop arguments');
      // Reject rather than silently accepting model-supplied session authority.
      if (RESERVED.some(key => Object.hasOwn(parameters, key))) throw new Error('Desktop session and file storage are Main-owned');
      let session = this.sessions.get(run.runId);
      if (!session) {
        session = `clawx-${randomUUID()}`;
        await client.startSession({ session }, { signal: combined });
        assertOwner(); this.sessions.set(run.runId, session);
      }
      const result = await client.callTool(args.name as string, JSON.stringify({ ...parameters, session }), { signal: combined });
      assertOwner();
      const content: ComputerToolResult['content'] = [];
      if (result.text) content.push({ type: 'text', text: result.text.slice(0, 128_000) });
      let size = 0;
      for (const image of result.images ?? []) {
        const bytes = Buffer.from(image.dataBase64, 'base64'); size += bytes.length;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) || size > 6 * 1024 * 1024
          || bytes.toString('base64') !== image.dataBase64) throw new Error('Invalid desktop image');
        content.push({ type: 'image', mimeType: image.mimeType, data: image.dataBase64 });
      }
      return { content, isError: result.isError };
    } catch (error) {
      // Failed/aborted native work cannot remain queued and act after revocation.
      this.failed = !combined.aborted;
      this.scope.abort(); await this.stopNative();
      if (!this.closed && epoch === this.epoch) this.scope = new AbortController();
      throw error;
    }
  }

  async endRun(runId: string): Promise<void> {
    const session = this.sessions.get(runId); this.sessions.delete(runId);
    if (session && this.active?.client) await this.active.client.endSession({ session }, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  }
  private async checkLease(): Promise<void> {
    const active = this.active;
    if (!active) return;
    const permissions = this.dependencies.permissions();
    if (!permissions.accessibility || !permissions.screenRecording || this.selected !== active.kernelId
      || this.dependencies.generation(active.kernelId) !== active.generation
      || (await this.dependencies.resolve(active.kernelId))?.key !== active.runtime.key) {
      this.scope.abort(); await this.stopNative();
      if (!this.closed) this.scope = new AbortController();
    }
  }
  private stopping?: Promise<void>;
  private async stopNative(): Promise<void> {
    if (this.stopping) return this.stopping;
    const active = this.active; this.active = undefined; this.sessions.clear();
    if (!active) return;
    const stopped = active.host.stop(); this.stopping = stopped;
    try { await stopped; } finally { if (this.stopping === stopped) this.stopping = undefined; }
  }
  async close(): Promise<void> {
    this.closed = true; this.epoch++; this.scope.abort(); clearInterval(this.timer);
    await this.configuration.catch(() => undefined); await this.stopNative();
  }
}
