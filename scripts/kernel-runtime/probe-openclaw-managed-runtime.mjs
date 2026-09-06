#!/usr/bin/env node
/** Real Gateway + real ACP + deterministic loopback provider; no user state or credentials. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { projectOpenClawConfigForRuntime } from '../../electron/gateway/config-projection.ts';
import { fixupPluginManifest } from '../../electron/utils/plugin-manifest.ts';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const packageDir = resolve(args.get('--package-dir') || 'node_modules/openclaw');
const node = resolve(args.get('--node') || process.execPath);
const version = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')).version;
const { isClawXHistoryTable } = await import(pathToFileURL(join(packageDir, 'dist/clawx-managed-storage.js')).href);
const root = await mkdtemp(join(tmpdir(), 'clawx-openclaw-managed-'));
const children = [];
const pending = new Map();
const providerRequests = [];
const updates = [];
const handoffs = [];
const permissions = [];
let rejectHandoff = false;
let logs = '';
let provider;
let lines;
let sequence = 0;
let acp;
try {
  const state = join(root, 'state');
  const workspace = join(root, 'workspace');
  const cache = join(root, 'cache');
  for (const path of [state, workspace, cache]) await mkdir(path, { mode: 0o700 });
  provider = createServer(async (req, res) => {
    try {
      if (req.url === '/clawx-channel') {
        assert.equal(req.headers.authorization, 'Bearer clawx-isolated-channel-token');
        let body = '';
        for await (const chunk of req) body += chunk;
        if (rejectHandoff) { res.writeHead(503); res.end(); return; }
        handoffs.push(JSON.parse(body));
        res.writeHead(202); res.end(); return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'clawx-probe', object: 'model' }] }));
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      providerRequests.push(request);
      if (JSON.stringify(request.messages).includes('DELAY_USER_MARKER')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        return; // cancellation/disconnect closes this owned loopback stream
      }
      const id = `clawx-provider-${providerRequests.length}`;
      const wantsTool = JSON.stringify(request.messages).includes('TOOL_USER_MARKER') && !request.messages.some(item => item.role === 'tool');
      const message = wantsTool
        ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'clawx-probe-exec', type: 'function', function: { name: 'exec', arguments: JSON.stringify({ command: 'echo CLAWX_TOOL_OK' }) } }] }
        : { role: 'assistant', content: 'CANONICAL_PROBE_OK' };
      const usage = { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 };
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const value of [
          { id, object: 'chat.completion.chunk', model: 'clawx-probe', choices: [{ index: 0, delta: message, finish_reason: null }] },
          { id, object: 'chat.completion.chunk', model: 'clawx-probe', choices: [{ index: 0, delta: {}, finish_reason: wantsTool ? 'tool_calls' : 'stop' }], usage },
        ]) res.write(`data: ${JSON.stringify(value)}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, object: 'chat.completion', model: 'clawx-probe', choices: [{ index: 0, message, finish_reason: 'stop' }], usage }));
      }
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(accept => provider.listen(0, '127.0.0.1', accept));
  const reservation = createServer();
  await new Promise(accept => reservation.listen(0, '127.0.0.1', accept));
  const gatewayPort = reservation.address().port;
  await new Promise(accept => reservation.close(accept));
  const token = randomUUID();
  const config = {
    logging: { file: join(cache, 'gateway.log') },
    gateway: { mode: 'local', port: gatewayPort, bind: 'loopback', auth: { mode: 'token', token }, controlUi: { enabled: false } },
    agents: { ownership: 'explicit', defaults: { model: { primary: 'clawx-probe/clawx-probe' }, systemAgent: { agentId: 'main' }, heartbeat: { every: '0m' } }, entries: { main: { workspace } } },
    models: { mode: 'merge', providers: { 'clawx-probe': { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'clawx-test-only', api: 'openai-completions', models: [{ id: 'clawx-probe', name: 'ClawX local probe', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
    plugins: { allow: ['clawx-channel-handoff', 'clawx-runtime-probe'], load: { paths: [existsSync(join(packageDir, 'clawx-channel-handoff')) ? join(packageDir, 'clawx-channel-handoff') : resolve('kernels/openclaw/overlay/clawx-channel-handoff'), resolve('scripts/kernel-runtime/fixtures/openclaw-probe')] }, entries: { 'clawx-channel-handoff': { enabled: true }, 'clawx-runtime-probe': { enabled: true }, 'memory-core': { config: { dreaming: { enabled: false } } } } },
    cron: { enabled: false },
    tools: { profile: 'full', sessions: { visibility: 'self' }, agentToAgent: { enabled: false } },
  };
  if (args.has('--plugins-root')) {
    const pluginsRoot = resolve(args.get('--plugins-root'));
    const installRecords = {};
    for (const [name, mirror] of [['@openclaw/discord', 'discord'], ['@openclaw/whatsapp', 'whatsapp'], ['@openclaw/qqbot', 'qqbot'], ['@soimy/dingtalk', 'dingtalk'], ['@larksuite/openclaw-lark', 'feishu-openclaw-plugin'], ['@wecom/wecom-openclaw-plugin', 'wecom'], ['@tencent-weixin/openclaw-weixin', 'openclaw-weixin']]) {
      const source = existsSync(join(pluginsRoot, mirror)) ? join(pluginsRoot, mirror) : join(pluginsRoot, name);
      const path = join(state, 'extensions', name.replaceAll('/', '_'));
      await cp(await realpath(source), path, { recursive: true, dereference: true });
      fixupPluginManifest(path);
      // Exactly the host mirror's peer-link rule: own link to the verified
      // active runtime, not pnpm's ancestor link or another installed version.
      await mkdir(join(path, 'node_modules'), { recursive: true });
      await symlink(await realpath(packageDir), join(path, 'node_modules/openclaw'), process.platform === 'win32' ? 'junction' : 'dir');
      const manifest = JSON.parse(await readFile(join(path, 'openclaw.plugin.json'), 'utf8'));
      config.plugins.allow.push(manifest.id);
      config.plugins.entries[manifest.id] = { enabled: true };
      config.plugins.load.paths.push(path);
      const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      installRecords[manifest.id] = { source: ['openclaw-lark', 'wecom'].includes(manifest.id) ? 'path' : 'npm', spec: name, resolvedName: name, resolvedSpec: `${name}@${pkg.version}`, resolvedVersion: pkg.version, version: pkg.version, installPath: await realpath(path), installedAt: new Date().toISOString() };
    }
    // Use the host's exact production table contract in this fresh test DB.
    // No trust bypass: the real loader validates npm identity and install path.
    await mkdir(join(state, 'state'));
    const hostIndex = await readFile(resolve('electron/utils/plugin-install-index.ts'), 'utf8');
    const schema = hostIndex.match(/const INSTALLED_PLUGIN_INDEX_TABLE_SQL = `([\s\S]*?)`;/)?.[1];
    assert.ok(schema, 'Production plugin index schema changed');
    const db = new DatabaseSync(join(state, 'state/openclaw.sqlite'));
    try {
      db.exec(schema);
      db.prepare("INSERT INTO installed_plugin_index VALUES (?, 1, 'clawx-managed', 'clawx-managed', 1, 'clawx-managed', ?, 'source-changed', ?, '[]', '[]', '', ?)")
        .run('installed-plugin-index', Date.now(), JSON.stringify(installRecords), Date.now());
    } finally { db.close(); }
  }
  await writeFile(join(state, 'openclaw.json'), JSON.stringify(projectOpenClawConfigForRuntime(config, true)), { mode: 0o600 });
  const env = {
    PATH: process.env.PATH, LANG: 'en_US.UTF-8',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT } : {}),
    CLAWX_MANAGED_RUNTIME: '1', CLAWX_OPENCLAW_PACKAGE_DIR: packageDir,
    CLAWX_ISOLATED_RUNTIME_PROBE: '1',
    CLAWX_CHANNEL_HANDOFF_URL: `http://127.0.0.1:${provider.address().port}/clawx-channel`,
    CLAWX_CHANNEL_HANDOFF_TOKEN: 'clawx-isolated-channel-token',
    CLAWX_CONVERSATION_STORE_PROTOCOL: 'clawx.conversation-store/v1',
    OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: join(state, 'openclaw.json'), OPENCLAW_CACHE_DIR: cache,
    OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_NO_RESPAWN: '1', OPENCLAW_SKIP_CRON: '1', OPENCLAW_EMBEDDED_IN: 'ClawX',
    OPENCLAW_HISTORY_MODE: 'clawx-data-service', OPENCLAW_DISABLE_NATIVE_HISTORY: '1', OPENCLAW_DISABLE_CRON_HISTORY: '1',
    OPENCLAW_DISABLE_TRANSCRIPT_USAGE_SCAN: '1', OPENCLAW_TRAJECTORY_ENABLED: '0',
    CLAWX_DISABLE_NATIVE_HISTORY: '1', CLAWX_DISABLE_NATIVE_SCHEDULER: '1',
    TMPDIR: cache, TMP: cache, TEMP: cache,
  };
  const launch = (argv) => {
    const child = spawn(node, [join(packageDir, 'openclaw.mjs'), ...argv], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.push(child);
    child.stderr.on('data', bytes => { logs = `${logs}${bytes}`.slice(-16000); });
    return child;
  };
  const startPair = async () => {
  const gateway = launch(['gateway', 'run', '--port', String(gatewayPort), '--bind', 'loopback']);
  gateway.stdout.on('data', bytes => { logs = `${logs}${bytes}`.slice(-16000); });
  const deadline = Date.now() + 90000;
  while (true) {
    if (gateway.exitCode !== null) throw new Error('Gateway exited during startup');
    if (Date.now() > deadline) throw new Error('Gateway startup timed out');
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`, { signal: AbortSignal.timeout(500) });
      if (response.ok) break;
    } catch {}
    await new Promise(accept => setTimeout(accept, 200));
  }
  acp = launch(['acp']);
  lines = createInterface({ input: acp.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.method === 'session/update') updates.push(message.params);
      if (message.method === 'session/request_permission') {
        permissions.push(message.params);
        // Approve only the fixed test echo. Never execute model-selected code.
        const safe = JSON.stringify(message.params.toolCall).includes('echo CLAWX_TOOL_OK');
        const option = message.params.options.find(item => item.kind === 'allow_once');
        acp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: safe && option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } })}\n`);
        return;
      }
      if (message.id && pending.has(message.id)) pending.get(message.id)(message);
    } catch { logs += `\nNon-JSON ACP line: ${line.slice(0, 200)}`; }
  });
  await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'clawx', version: '1' } });
  return gateway;
  };
  let gateway = await startPair();
  const identity = { conversationId: 'canonical-probe', runId: randomUUID(), turnId: 'current', generation: 1 };
  const digest = createHash('sha256').update(JSON.stringify([identity.conversationId, identity.runId, identity.generation])).digest('hex');
  const key = `agent:main:dashboard:incognito-clawx-${digest}`;
  const history = [
    { id: 'prior-user', turnId: 'u1', role: 'user', position: 0, type: 'text', visibility: 'portable', text: 'CANONICAL_USER_MARKER' },
    { id: 'prior-assistant', turnId: 'a1', role: 'assistant', position: 0, type: 'text', visibility: 'portable', text: 'CANONICAL_ASSISTANT_MARKER' },
  ];
  const session = await request('session/new', { cwd: workspace, mcpServers: [], _meta: { sessionKey: key, prefixCwd: false, clawx: { protocol: 'clawx.openclaw-session/v1', ...identity, agentId: 'main', history, model: 'clawx-probe/clawx-probe', permissionMode: 'read-only' } } });
  const prompt = await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'CURRENT_USER_MARKER' }], _meta: { messageId: identity.runId, prefixCwd: false } });
  assert.equal(prompt.stopReason, 'end_turn');
  assert.ok(providerRequests.length > 0, 'The real provider execution path was not called');
  const messages = providerRequests.find(item => JSON.stringify(item.messages).includes('CURRENT_USER_MARKER'))?.messages;
  assert.ok(messages, 'No provider request contains the current canonical turn');
  for (const [role, marker] of [['user', 'CANONICAL_USER_MARKER'], ['assistant', 'CANONICAL_ASSISTANT_MARKER'], ['user', 'CURRENT_USER_MARKER']]) {
    assert.equal(messages.filter(message => message.role === role && JSON.stringify(message.content).includes(marker)).length, 1, `${marker} must occur once with its real role`);
  }
  await request('session/close', { sessionId: session.sessionId });
  await assert.rejects(request('session/load', { sessionId: session.sessionId, cwd: workspace, mcpServers: [] }), /canonical|managed/i);
  const newRun = async (turnId, generation = 1, priorHistory = history, permissionMode = 'guarded') => {
    const admitted = { ...identity, runId: randomUUID(), turnId, generation };
    const hash = createHash('sha256').update(JSON.stringify([admitted.conversationId, admitted.runId, admitted.generation])).digest('hex');
    const created = await request('session/new', { cwd: workspace, mcpServers: [], _meta: { sessionKey: `agent:main:dashboard:incognito-clawx-${hash}`, prefixCwd: false, clawx: { protocol: 'clawx.openclaw-session/v1', ...admitted, agentId: 'main', history: priorHistory, model: 'clawx-probe/clawx-probe', permissionMode } } });
    return { ...admitted, sessionId: created.sessionId };
  };
  const promptRun = (run, marker) => request('session/prompt', { sessionId: run.sessionId, prompt: [{ type: 'text', text: marker }], _meta: { messageId: run.runId, prefixCwd: false } });
  const toolRun = await newRun('tool-turn');
  await request('session/set_config_option', { sessionId: toolRun.sessionId, configId: 'clawx_model', value: 'clawx-probe/clawx-probe' });
  await request('session/set_config_option', { sessionId: toolRun.sessionId, configId: 'clawx_permission_mode', value: 'guarded' });
  assert.equal((await promptRun(toolRun, 'TOOL_USER_MARKER')).stopReason, 'end_turn');
  assert.ok(updates.some(item => item.sessionId === toolRun.sessionId && item.update.sessionUpdate === 'tool_call'), 'Native tool start did not reach ACP');
  assert.ok(updates.some(item => item.sessionId === toolRun.sessionId && item.update.sessionUpdate === 'tool_call_update'), 'Native tool completion did not reach ACP');
  assert.ok(permissions.length > 0, 'Guarded execution did not ask for scoped approval');
  await request('session/close', { sessionId: toolRun.sessionId });
  const cancelRun = await newRun('cancel-turn');
  const cancelling = promptRun(cancelRun, 'DELAY_USER_MARKER');
  await waitFor(() => providerRequests.some(item => JSON.stringify(item.messages).includes('DELAY_USER_MARKER')));
  acp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: cancelRun.sessionId } })}\n`);
  assert.equal((await cancelling).stopReason, 'cancelled');
  await request('session/close', { sessionId: cancelRun.sessionId });
  const interruptRun = await newRun('disconnect-turn');
  const beforeInterrupted = providerRequests.length;
  const interrupted = promptRun(interruptRun, 'DELAY_USER_MARKER');
  const interruptionCheck = assert.rejects(interrupted, /canonical run interrupted/i);
  await waitFor(() => providerRequests.length > beforeInterrupted);
  gateway.kill('SIGKILL'); // deliberate crash of this probe's owned process
  await interruptionCheck;
  await stopChildren();
  lines.close();
  gateway = await startPair();
  const continuedHistory = [...history, { id: 'previous-current', turnId: 'previous-current', role: 'user', position: 0, type: 'text', visibility: 'portable', text: 'CURRENT_USER_MARKER' }, { id: 'previous-final', turnId: 'previous-final', role: 'assistant', position: 0, type: 'text', visibility: 'portable', text: 'CANONICAL_PROBE_OK', kernelId: 'deepseek-harness' }];
  const resumed = await newRun('restart-turn', 2, continuedHistory, 'read-only');
  assert.equal((await promptRun(resumed, 'RESTART_USER_MARKER')).stopReason, 'end_turn');
  for (const marker of ['CANONICAL_USER_MARKER', 'CANONICAL_ASSISTANT_MARKER', 'CURRENT_USER_MARKER', 'RESTART_USER_MARKER']) {
    assert.equal(providerRequests.at(-1).messages.filter(message => JSON.stringify(message.content).includes(marker)).length, 1, `Cold restart duplicated ${marker}`);
  }
  await request('session/close', { sessionId: resumed.sessionId });
  let channelLoad;
  if (args.has('--plugins-root')) {
    const inspect = launch(['gateway', 'call', 'clawx.test.channels', '--params', JSON.stringify({ channels: ['discord', 'whatsapp', 'qqbot', 'dingtalk', 'feishu', 'wecom', 'openclaw-weixin'] }), '--json']);
    let output = '';
    inspect.stdout.on('data', bytes => { output += bytes; });
    assert.equal((await once(inspect, 'exit'))[0], 0, output);
    channelLoad = JSON.parse(output.slice(output.indexOf('{')));
    assert.ok(channelLoad.results.every(item => item.sendCapable), `Channel execution module failed to load: ${JSON.stringify(channelLoad)}`);
    assert.ok(channelLoad.results.every(item => item.plugins?.every(plugin => plugin.status !== 'error')), `Channel registration failed: ${JSON.stringify(channelLoad)}`);
  }
  const ingress = launch(['gateway', 'call', 'clawx.test.ingress', '--params', JSON.stringify({ messageId: 'channel-probe-1', text: 'CANONICAL_CHANNEL_MARKER' }), '--json']);
  let ingressOutput = '';
  ingress.stdout.on('data', bytes => { ingressOutput += bytes; });
  const [ingressCode] = await once(ingress, 'exit');
  assert.equal(ingressCode, 0, `Real Channel dispatch failed: ${ingressOutput}`);
  assert.equal(handoffs.length, 1, 'Channel ingress did not reach canonical admission exactly once');
  assert.equal(handoffs[0].externalMessageId, 'channel-probe-1');
  assert.equal(handoffs[0].text, 'CANONICAL_CHANNEL_MARKER');
  rejectHandoff = true;
  const rejected = launch(['gateway', 'call', 'clawx.test.ingress', '--params', JSON.stringify({ messageId: 'channel-rejected', text: 'REJECTED_CHANNEL_MARKER' }), '--json']);
  rejected.stdout.resume();
  assert.notEqual((await once(rejected, 'exit'))[0], 0, 'Rejected canonical admission must fail, not run a native fallback');
  assert.equal(handoffs.length, 1);
  assert.equal(providerRequests.length, 6, 'A native Channel/automatic-title model run bypassed canonical admission');
  await stopChildren();
  const databases = [];
  const scan = async path => {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const child = join(path, item.name);
      if (item.isDirectory()) await scan(child);
      else if (item.name.endsWith('.sqlite')) {
        const db = new DatabaseSync(child, { readOnly: true });
        try {
          const tables = {};
          for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
            const count = db.prepare(`SELECT count(*) AS n FROM "${String(name).replaceAll('"', '""')}"`).get().n;
            if (isClawXHistoryTable(name, child.includes('openclaw-agent.sqlite') ? 'agent' : 'state') && !/_fts(?:_|$)/.test(name)) {
              assert.equal(count, 0, `Native history leaked into ${name}`);
            }
            if (count) tables[name] = count;
          }
          databases.push({ path: child.slice(root.length + 1), tables });
        } finally { db.close(); }
      }
    }
  };
  await scan(root);
  const usage = updates.filter(item => item.update.sessionUpdate === 'usage_update');
  assert.equal(usage.length, 4, 'Only completed provider responses may produce known billable usage');
  for (const event of usage) {
    assert.equal(event.update._meta.clawx.input, 11);
    assert.equal(event.update._meta.clawx.output, 5);
    assert.equal(event.update._meta.clawx.cost, undefined, 'Provider did not report billed cost; configured zero pricing is not a billing fact');
  }
  assert.equal(new Set(usage.map(item => item.update._meta.clawx.eventKey)).size, 4);
  const report = { ok: true, version, realGateway: true, realAcp: true, provider: 'loopback-test-only', providerCalls: providerRequests.length, rolesPreserved: true, toolApproval: true, cancel: true, crashRehydrate: true, nativeDurableHistory: false, channelHandoffs: handoffs.length, rejectedChannelFailsClosed: true, channelLoad: channelLoad?.results.map(({ channel, sendCapable }) => ({ channel, sendCapable })), usage: usage.map(item => item.update._meta.clawx), databases };
  if (args.has('--report')) {
    const reportPath = resolve(args.get('--report'));
    await mkdir(join(reportPath, '..'), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n${logs}\nProvider probe message roles: ${JSON.stringify(providerRequests.map(item => item.messages?.map(message => message.role)))}\n`);
  process.exitCode = 1;
} finally {
  await stopChildren();
  lines?.close();
  if (provider) await new Promise(accept => provider.close(accept));
  await rm(root, { recursive: true, force: true });
}

function request(method, params) {
  const id = ++sequence;
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 60000);
    pending.set(id, response => {
      clearTimeout(timer); pending.delete(id);
      if (response.error) reject(new Error(`${method}: ${JSON.stringify(response.error)}`));
      else accept(response.result);
    });
    acp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function stopChildren() {
  for (const child of [...children].reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Runtime probe condition timed out');
    await new Promise(accept => setTimeout(accept, 50));
  }
}
