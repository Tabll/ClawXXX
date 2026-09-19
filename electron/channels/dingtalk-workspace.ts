import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DingTalkWorkspaceStatus } from '@shared/domains/dingtalk-workspace';
import type { ChannelOwnerLease } from '@shared/domains/channels';
import type { KernelId } from '@shared/kernels/contracts';
import type { CanonicalChannelAccountService } from './channel-account-service';
import { captureChannelAuthBundle, restoreChannelAuthBundle } from './channel-auth-bundle';
import { terminateOwnedKernelProcessTree } from '../kernels/stdio-kernel-process';

const OUTPUT_LIMIT = 1024 * 1024;
type Context = { accountId: string; lease: ChannelOwnerLease; executable: string; fingerprint: string; env: NodeJS.ProcessEnv; root: string };
type Operation = { snapshot: DingTalkWorkspaceStatus; child?: ChildProcessWithoutNullStreams; finished?: boolean; cancel(): Promise<void>; done: Promise<void> };
export type DingTalkWorkspaceDependencies = {
  accounts: Pick<CanonicalChannelAccountService, 'getById' | 'getProjectionConfig' | 'updateSecrets'>;
  owner(accountId: string): ChannelOwnerLease | undefined;
  executable(kernelId: KernelId): Promise<string | undefined>;
  projectionRoot: string;
  spawn?: typeof spawn;
  terminate?: typeof terminateOwnedKernelProcessTree;
  now?: () => number;
  startTimeoutMs?: number;
};

/** Canonical credentials are durable; every CLI process receives a disposable account projection. */
export class DingTalkWorkspaceService {
  private readonly operations = new Map<string, Operation>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly children = new Map<string, Set<ChildProcessWithoutNullStreams>>();
  private readonly epochs = new Map<string, number>();
  private stopped = false;
  constructor(private readonly deps: DingTalkWorkspaceDependencies) {}

  async status(accountId: string): Promise<DingTalkWorkspaceStatus> {
    const active = this.operations.get(accountId);
    if (active) {
      if (active.finished) this.operations.delete(accountId);
      return { ...active.snapshot };
    }
    return this.serial(accountId, async () => {
      const context = await this.context(accountId);
      if (!context) return { status: 'unavailable' };
      try { return await this.probe(context); }
      finally { await rm(context.root, { recursive: true, force: true }); }
    });
  }

  async start(accountId: string): Promise<DingTalkWorkspaceStatus> {
    return this.serial(accountId, async () => {
      await this.cancel(accountId);
      const context = await this.context(accountId);
      if (!context) return { status: 'unavailable' };
      try {
        if ((await this.probe(context)).status === 'authorized') return { status: 'authorized' };
        return await this.launchLogin(context);
      } finally {
        // A pending login owns its projection until exit/cancel, including the
        // secure persistence step. Status probes never share its mutable files.
        if (!this.operations.has(accountId)) await rm(context.root, { recursive: true, force: true });
      }
    });
  }

  async cancel(accountId: string, authorizationId?: string): Promise<DingTalkWorkspaceStatus> {
    const operation = this.operations.get(accountId);
    if (authorizationId && operation?.snapshot.authorizationId !== authorizationId) return { status: 'needs_auth' };
    this.epochs.set(accountId, (this.epochs.get(accountId) ?? 0) + 1);
    if (operation) { await operation.cancel(); await operation.done; }
    if (this.operations.get(accountId) === operation) this.operations.delete(accountId);
    await Promise.all([...this.children.get(accountId) ?? []].map(child => this.terminateAndWait(child)));
    return { status: 'needs_auth' };
  }

  async reset(accountId: string): Promise<DingTalkWorkspaceStatus> {
    return this.serial(accountId, async () => {
      await this.cancel(accountId);
      await this.deps.accounts.updateSecrets(accountId, { dwsAuthBundle: '' });
      return { status: 'needs_auth' };
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...new Set([...this.operations.keys(), ...this.children.keys()])].map(id => this.cancel(id)));
    await Promise.allSettled([...this.tails.values()]);
  }

  /** Main's run-owned tool bridge calls this; there is no Renderer execute route. */
  async execute(accountId: string, kernelId: KernelId, args: string[], signal?: AbortSignal): Promise<string> {
    if (!Array.isArray(args) || args.length === 0 || args.length > 128
      || args.some(arg => typeof arg !== 'string' || arg.length > 16_384 || arg.includes('\0'))
      || args.some(arg => /^(?:auth|--(?:client-id|client-secret|token|config(?:-dir)?|mock|debug|verbose))(?:=|$)/.test(arg))) {
      throw new Error('DWS command must use the selected canonical account');
    }
    if (this.operations.get(accountId)?.finished) this.operations.delete(accountId);
    if (this.operations.has(accountId)) throw new Error('DWS account authorization is busy');
    return this.serial(accountId, async () => {
      const context = await this.context(accountId);
      if (!context || context.lease.kernelId !== kernelId) {
        if (context) await rm(context.root, { recursive: true, force: true });
        throw new Error('DWS account has no matching active kernel owner');
      }
      try {
        if (signal?.aborted) throw new Error('DWS command cancelled');
        if ((await this.probe(context)).status !== 'authorized') throw new Error('DWS account requires workspace authorization');
        const result = await this.run(context, [...args, '--format', 'json'], 60_000, signal);
        if (result.code !== 0) throw new Error(`DWS command failed: ${classifyDwsFailure(result.errorOutput)}`);
        await this.persist(context);
        return result.output;
      } finally { await rm(context.root, { recursive: true, force: true }); }
    });
  }

  private async context(accountId: string): Promise<Context | undefined> {
    if (this.stopped) return undefined;
    const epoch = this.epochs.get(accountId);
    const account = await this.deps.accounts.getById(accountId);
    if (!account || account.channelType !== 'dingtalk' || !account.enabled) return undefined;
    const lease = this.deps.owner(accountId);
    if (!lease) return undefined;
    const executable = await this.deps.executable(lease.kernelId);
    if (!executable) return undefined;
    const config = await this.deps.accounts.getProjectionConfig(account);
    if (typeof config.clientId !== 'string' || typeof config.clientSecret !== 'string') return undefined;
    const fingerprint = credentialFingerprint(config);
    await mkdir(this.deps.projectionRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(this.deps.projectionRoot, 'account-'));
    try {
      if (typeof config.dwsAuthBundle === 'string' && config.dwsAuthBundle) {
        const saved = JSON.parse(config.dwsAuthBundle) as { fingerprint: string; bundle: string };
        if (saved.fingerprint === fingerprint) await restoreChannelAuthBundle(join(root, 'config'), saved.bundle);
      }
      await mkdir(join(root, 'config'), { recursive: true, mode: 0o700 });
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
        'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
        if (process.env[key]) env[key] = process.env[key];
      }
      Object.assign(env, { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root,
        DWS_CONFIG_DIR: join(root, 'config'), DINGTALK_AGENT: 'DING_DWS_CLAW',
        DWS_CLIENT_ID: config.clientId, DWS_CLIENT_SECRET: config.clientSecret });
      if (this.stopped || this.epochs.get(accountId) !== epoch || this.deps.owner(accountId)?.generation !== lease.generation) {
        await rm(root, { recursive: true, force: true }); return undefined;
      }
      return { accountId, lease: { ...lease }, executable, fingerprint, env, root };
    } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  }

  private async persist(context: Context): Promise<void> {
    const account = await this.deps.accounts.getById(context.accountId);
    const lease = this.deps.owner(context.accountId);
    if (this.stopped || !account?.enabled || !lease || lease.ownerId !== context.lease.ownerId
      || lease.kernelId !== context.lease.kernelId || lease.generation !== context.lease.generation
      || credentialFingerprint(await this.deps.accounts.getProjectionConfig(account)) !== context.fingerprint) {
      throw new Error('DWS authorization owner changed');
    }
    const bundle = await captureChannelAuthBundle(join(context.root, 'config'));
    await this.deps.accounts.updateSecrets(context.accountId, {
      dwsAuthBundle: JSON.stringify({ fingerprint: context.fingerprint, bundle }),
    });
  }

  private async probe(context: Context): Promise<DingTalkWorkspaceStatus> {
    try {
      const result = await this.run(context, ['auth', 'status', '--format', 'json'], 8_000);
      return { status: result.code === 0 && JSON.parse(result.output).authenticated === true ? 'authorized' : 'needs_auth' };
    } catch { return { status: 'needs_auth' }; }
  }

  private launchLogin(context: Context): Promise<DingTalkWorkspaceStatus> {
    let resolveStart!: (status: DingTalkWorkspaceStatus) => void;
    const started = new Promise<DingTalkWorkspaceStatus>(resolve => { resolveStart = resolve; });
    let settleDone!: () => void;
    const done = new Promise<void>(resolve => { settleDone = resolve; });
    let cancelled = false;
    let settled = false;
    let output = '';
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => { if (!settled) { settled = true; clearTimeout(startTimer); resolveStart({ ...operation.snapshot }); } };
    const authorizationId = randomUUID();
    const operation: Operation = { snapshot: { status: 'starting', authorizationId }, done,
      cancel: async () => {
        cancelled = true;
        operation.snapshot = { status: 'needs_auth' };
        settle();
        if (operation.child) await this.terminate(operation.child);
      } };
    this.operations.set(context.accountId, operation);
    const finish = async (code: number | null) => {
      clearTimeout(expiry); clearTimeout(startTimer);
      try {
        if (!cancelled && operation.snapshot.status !== 'error') {
          if (code === 0 && (await this.probe(context)).status === 'authorized') {
            if (!cancelled) { await this.persist(context); operation.snapshot = { status: 'authorized' }; }
          } else operation.snapshot = { status: 'error', error: classifyDwsFailure(output) };
        }
      } catch { operation.snapshot = { status: 'error', error: 'owner_changed' }; }
      finally {
        settle();
        await rm(context.root, { recursive: true, force: true }).catch(() => undefined);
        // Keep final status until explicitly acknowledged by status(); pending
        // and failure states never contain the CLI output or credentials.
        operation.finished = true; settleDone();
      }
    };
    let finished = false;
    const finishOnce = (code: number | null) => { if (!finished) { finished = true; void finish(code); } };
    try {
      const child = this.spawn(context, ['auth', 'login', '--format', 'json']);
      operation.child = child;
      const consume = (chunk: Buffer) => {
        if (cancelled || operation.snapshot.status === 'error') return;
        output = `${output}${String(chunk)}`.slice(-32 * 1024);
        const parsed = parseDwsLoginOutput(output, this.now());
        if (!parsed || operation.snapshot.status === 'pending') return;
        operation.snapshot = { ...parsed, authorizationId };
        expiry = setTimeout(() => {
          operation.snapshot = { status: 'error', error: 'expired' };
          void this.terminate(child);
        }, Math.max(1, parsed.expiresAt! - this.now()));
        expiry.unref?.(); settle();
      };
      child.stdout.on('data', consume); child.stderr.on('data', consume);
      child.once('error', () => finishOnce(null)); child.once('close', finishOnce);
      startTimer = setTimeout(() => {
        operation.snapshot = { status: 'error', error: 'start_timeout' };
        settle(); void this.terminate(child);
      }, this.deps.startTimeoutMs ?? 20_000);
      startTimer.unref?.();
    } catch { operation.snapshot = { status: 'error', error: 'failed' }; finishOnce(null); }
    void done.then(() => {
      if (cancelled && this.operations.get(context.accountId) === operation) this.operations.delete(context.accountId);
    });
    return started;
  }

  private spawn(context: Context, args: string[]): ChildProcessWithoutNullStreams {
    const child = (this.deps.spawn ?? spawn)(context.executable, args, {
      cwd: context.root, env: context.env, stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, shell: false, detached: process.platform !== 'win32',
    });
    const children = this.children.get(context.accountId) ?? new Set();
    children.add(child); this.children.set(context.accountId, children);
    child.once('close', () => {
      children.delete(child);
      if (!children.size) this.children.delete(context.accountId);
    });
    return child;
  }

  private run(context: Context, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; output: string; errorOutput: string }> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(context, args);
      let output = ''; let errorOutput = ''; let failure: Error | undefined;
      const abort = () => { failure = new Error('DWS command cancelled'); void this.terminate(child); };
      const timer = setTimeout(() => { failure = new Error('DWS command timed out'); void this.terminate(child); }, timeoutMs);
      timer.unref?.();
      const consume = (chunk: Buffer, stderr: boolean) => {
        if (output.length + errorOutput.length + chunk.length > OUTPUT_LIMIT) { failure = new Error('DWS output limit exceeded'); void this.terminate(child); return; }
        if (stderr) errorOutput += String(chunk); else output += String(chunk);
      };
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on('data', chunk => consume(chunk, false)); child.stderr.on('data', chunk => consume(chunk, true));
      child.once('error', () => { clean(); reject(new Error('DWS process failed')); });
      child.once('close', code => { clean(); if (failure) reject(failure); else resolve({ code, output, errorOutput }); });
    });
  }

  private async terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const terminate = this.deps.terminate ?? terminateOwnedKernelProcessTree;
    await terminate(child, 'SIGTERM').catch(() => undefined);
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) void terminate(child, 'SIGKILL'); }, 1_500);
    timer.unref?.(); child.once('close', () => clearTimeout(timer));
  }
  private async terminateAndWait(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    await this.terminate(child); await closed;
  }
  private now() { return this.deps.now?.() ?? Date.now(); }
  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.tails.set(id, result);
    void result.finally(() => { if (this.tails.get(id) === result) this.tails.delete(id); }).catch(() => undefined);
    return result;
  }
}

function credentialFingerprint(config: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify([config.clientId, config.clientSecret])).digest('hex');
}

export function classifyDwsFailure(output: string): NonNullable<DingTalkWorkspaceStatus['error']> {
  if (/invalid.client|client.?secret.*(?:invalid|incorrect)/i.test(output)) return 'invalid_client';
  if (/尚未开启.*cli|未开启.*允许成员通过.*cli|cli.*access.*(?:disabled|not enabled)/i.test(output)) return 'org_cli_disabled';
  if (/access.denied|authorization.denied|拒绝授权|取消授权/i.test(output)) return 'denied';
  if (/permission.denied|forbidden|missing.*scope|权限不足/i.test(output)) return 'permission_denied';
  if (/expired.token|device code.*expired|授权码.*过期/i.test(output)) return 'expired';
  if (/network.error|connection (?:refused|reset)|timeout|网络.*(?:失败|异常)/i.test(output)) return 'network_error';
  return 'failed';
}

export function parseDwsLoginOutput(output: string, now: number): DingTalkWorkspaceStatus | undefined {
  // Only the official HTTPS authorization origin may cross into the UI.
  for (const raw of output.match(/https:\/\/[^\s│<>"']+/g) ?? []) {
    try {
      const url = new URL(raw);
      if (url.hostname !== 'login.dingtalk.com' || url.port || url.username || url.password || !url.pathname.startsWith('/oauth2/')) continue;
      const userCode = url.searchParams.get('user_code') ?? output.match(/(?:授权码|user[_ ]?code)\s*[:：]\s*([A-Z0-9-]+)/i)?.[1];
      const seconds = Number(output.match(/(?:将在|expires?\s+in)\s*(\d+)\s*(?:秒|seconds?)/i)?.[1]) || 600;
      return { status: 'pending', verificationUri: url.href, ...(userCode ? { userCode: userCode.slice(0, 64) } : {}),
        expiresAt: now + Math.min(Math.max(seconds, 1), 900) * 1000 };
    } catch { /* Ignore incomplete output chunks. */ }
  }
  return undefined;
}
