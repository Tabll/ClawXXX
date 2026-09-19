// @vitest-environment node
import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DingTalkWorkspaceService, parseDwsLoginOutput } from '@electron/channels/dingtalk-workspace';
import type { CanonicalChannelAccount, ChannelOwnerLease } from '@shared/domains/channels';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'clawx-dws-contract-'));
  const cli = join(root, 'cli.mjs');
  await writeFile(cli, `
    import { existsSync, writeFileSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    const args = process.argv.slice(2);
    const config = process.env.DWS_CONFIG_DIR;
    const auth = join(config, 'authorization.json');
    if (args[0] === 'auth' && args[1] === 'status') {
      process.stdout.write(JSON.stringify({authenticated:existsSync(auth)}));
    } else if (args[0] === 'auth' && args[1] === 'login') {
      if (process.env.DWS_CLIENT_ID !== 'timeout') console.log('https://login.dingtalk.com/oauth2/auth?state=fixture&user_code=CODE-' + process.env.DWS_CLIENT_ID);
      const timer = setInterval(() => {
        if (!existsSync(join(config,'approve'))) return;
        writeFileSync(auth, JSON.stringify({token:'fixture-token-' + process.env.DWS_CLIENT_ID}));
        clearInterval(timer);
      }, 10);
    } else {
      const saved = JSON.parse(readFileSync(auth,'utf8'));
      console.log(JSON.stringify({account:process.env.DWS_CLIENT_ID,tokenOwner:saved.token,secret:process.env.DWS_CLIENT_SECRET}));
    }
  `);
  const configs = new Map<string, Record<string, unknown>>([
    ['dingtalk:one', { clientId: 'one', clientSecret: 'one-secret' }],
    ['dingtalk:two', { clientId: 'two', clientSecret: 'two-secret' }],
  ]);
  const leases = new Map<string, ChannelOwnerLease>();
  for (const [index, id] of [...configs.keys()].entries()) leases.set(id, { accountId: id as CanonicalChannelAccount['id'],
    ownerId: 'fixture-owner', kernelId: index === 0 ? 'openclaw' : 'deepseek-harness', generation: 1,
    leaseExpiresAt: '2099-01-01T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z' });
  const launches: Array<{ account: string; args: string[]; root: string; env: NodeJS.ProcessEnv }> = [];
  const updated = vi.fn(async (id: string, values: Record<string, string>) => {
    if (!configs.has(id)) throw new Error('Deleted');
    configs.set(id, { ...configs.get(id), ...values });
  });
  const service = new DingTalkWorkspaceService({
    projectionRoot: join(root, 'projections'), startTimeoutMs: 300,
    accounts: {
      getById: async id => configs.has(id) ? { id, channelType: 'dingtalk', enabled: true } as CanonicalChannelAccount : undefined,
      getProjectionConfig: async account => structuredClone(configs.get(account.id)!), updateSecrets: updated,
    },
    owner: id => leases.get(id), executable: async () => process.execPath,
    spawn: ((_, args, options) => {
      const opts = options as SpawnOptionsWithoutStdio;
      launches.push({ account: opts.env!.DWS_CLIENT_ID!, args: args as string[], root: opts.env!.DWS_CONFIG_DIR!, env: opts.env! });
      return spawn(process.execPath, [cli, ...args as string[]], opts);
    }) as typeof spawn,
  });
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }); });
  cleanups.push(() => service.stop());
  const approve = async (account: string) => {
    const login = launches.findLast(item => item.account === account && item.args[1] === 'login')!;
    await writeFile(join(login.root, 'approve'), 'fixture');
    await expect.poll(async () => (await service.status(`dingtalk:${account}`)).status).toBe('authorized');
  };
  return { root, service, configs, leases, launches, updated, approve };
}

describe('canonical DingTalk workspace processes', () => {
  it('isolates concurrent account authorization, encrypted bundles and owner-specific commands', async () => {
    const f = await fixture();
    const [one, two] = await Promise.all([f.service.start('dingtalk:one'), f.service.start('dingtalk:two')]);
    expect(one).toMatchObject({ status: 'pending', userCode: 'CODE-one' });
    expect(two).toMatchObject({ status: 'pending', userCode: 'CODE-two' });
    expect(one.authorizationId).not.toBe(two.authorizationId);
    const logins = f.launches.filter(item => item.args[1] === 'login');
    expect(logins[0]!.root).not.toBe(logins[1]!.root);
    expect(logins.every(item => item.env.HOME !== process.env.HOME)).toBe(true);
    await f.approve('one'); await f.approve('two');
    expect(f.updated).toHaveBeenCalledTimes(2);
    const first = JSON.parse(await f.service.execute('dingtalk:one', 'openclaw', ['calendar', 'list']));
    const second = JSON.parse(await f.service.execute('dingtalk:two', 'deepseek-harness', ['doc', 'list']));
    expect(first).toMatchObject({ account: 'one', tokenOwner: 'fixture-token-one', secret: 'one-secret' });
    expect(second).toMatchObject({ account: 'two', tokenOwner: 'fixture-token-two', secret: 'two-secret' });
    await expect(f.service.execute('dingtalk:one', 'deepseek-harness', ['calendar', 'list'])).rejects.toThrow('matching active kernel owner');
    expect(await readdir(join(f.root, 'projections'))).toEqual([]);
  });

  it('cancels only the requested authorization and ignores an obsolete cancellation handle', async () => {
    const f = await fixture();
    const first = await f.service.start('dingtalk:one');
    const other = await f.service.start('dingtalk:two');
    await f.service.cancel('dingtalk:one', first.authorizationId);
    const replacement = await f.service.start('dingtalk:one');
    await f.service.cancel('dingtalk:one', first.authorizationId);
    expect(await f.service.status('dingtalk:one')).toMatchObject({ status: 'pending', authorizationId: replacement.authorizationId });
    expect(await f.service.status('dingtalk:two')).toMatchObject({ status: 'pending', authorizationId: other.authorizationId });
    expect(f.updated).not.toHaveBeenCalled();
  });

  it('refuses late success after owner changes and never restores a bundle after credential changes', async () => {
    const f = await fixture();
    await f.service.start('dingtalk:one');
    const login = f.launches.findLast(item => item.args[1] === 'login')!;
    f.leases.get('dingtalk:one')!.generation++;
    await writeFile(join(login.root, 'approve'), 'fixture');
    await expect.poll(async () => (await f.service.status('dingtalk:one')).error).toBe('owner_changed');
    expect(f.updated).not.toHaveBeenCalled();
    await f.service.start('dingtalk:one'); await f.approve('one');
    f.configs.get('dingtalk:one')!.clientSecret = 'changed';
    expect(await f.service.status('dingtalk:one')).toMatchObject({ status: 'needs_auth' });
    await f.service.reset('dingtalk:one');
    expect(f.configs.get('dingtalk:one')!.dwsAuthBundle).toBe('');
  });

  it('times out, kills and cleans up a login that never produces an official URL', async () => {
    const f = await fixture(); f.configs.get('dingtalk:one')!.clientId = 'timeout';
    expect(await f.service.start('dingtalk:one')).toMatchObject({ status: 'error', error: 'start_timeout' });
    await f.service.cancel('dingtalk:one');
    expect(await readdir(join(f.root, 'projections'))).toEqual([]);
    expect(f.updated).not.toHaveBeenCalled();
  });

  it('rejects credential overrides, auth commands and missing owners before spawning', async () => {
    const f = await fixture();
    for (const args of [['auth', 'login'], ['calendar', 'list', '--token=stolen'], ['doc', '--client-id', 'other']]) {
      await expect(f.service.execute('dingtalk:one', 'openclaw', args)).rejects.toThrow('canonical account');
    }
    f.leases.delete('dingtalk:one');
    expect(await f.service.start('dingtalk:one')).toEqual({ status: 'unavailable' });
    expect(f.launches).toHaveLength(0);
  });

  it('parses only official authorization URLs and bounds expiry', () => {
    expect(parseDwsLoginOutput('https://login.dingtalk.com.evil.test/oauth2/auth?user_code=CODE', 0)).toBeUndefined();
    expect(parseDwsLoginOutput('https://secret@login.dingtalk.com/oauth2/auth?user_code=CODE', 0)).toBeUndefined();
    expect(parseDwsLoginOutput('https://login.dingtalk.com/oauth2/auth?user_code=CODE expires in 99999 seconds', 0))
      .toMatchObject({ userCode: 'CODE', expiresAt: 900_000 });
  });
});
