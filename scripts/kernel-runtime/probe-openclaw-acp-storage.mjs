#!/usr/bin/env node
/**
 * Real ACP process, simulated Gateway, isolated configuration, no provider call.
 * A passing result proves only session/new did not persist ACP replay rows; it
 * does not replace real Gateway/prompt/cancel/Channel/Cron storage acceptance.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const packageRoot = resolve(required('--package-dir'));
const nodePath = resolve(required('--node'));
const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
if (metadata.name !== 'openclaw' || typeof metadata.version !== 'string') throw new Error('Invalid OpenClaw package identity');
const entrypoint = join(packageRoot, existsSync(join(packageRoot, 'clawx-openclaw.mjs')) ? 'clawx-openclaw.mjs' : 'openclaw.mjs');
const root = await mkdtemp(join(tmpdir(), 'clawx-openclaw-acp-storage-'));
let child;
let server;
let exited;
let stderr = '';
let lines;
const responses = new Map();
const methods = [];
const managed = metadata.clawx?.managedSessionProtocol === 'clawx.openclaw-session/v1';

try {
  const workspace = join(root, 'workspace');
  const state = join(root, 'state');
  const cache = join(root, 'cache');
  for (const directory of [workspace, state, cache]) await mkdir(directory, { mode: 0o700 });
  await writeFile(join(state, 'openclaw.json'), JSON.stringify({ gateway: { mode: 'local' } }), { mode: 0o600 });
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'clawx-test', ts: Date.now() } }));
    socket.on('message', bytes => {
      const request = JSON.parse(bytes.toString());
      methods.push(request.method);
      let payload;
      if (request.method === 'connect') payload = {
        type: 'hello-ok', protocol: 3,
        server: { version: 'clawx-storage-probe', connId: 'clawx-test' },
        features: { methods: ['sessions.list'], events: [] }, snapshot: {},
        policy: { tickIntervalMs: 30000 },
      };
      else if (request.method === 'sessions.list') payload = { sessions: [] };
      else if (managed && request.method === 'sessions.create') payload = { key: request.params.key, sessionId: 'probe-native', entry: { incognito: true } };
      else if (managed && ['clawx.session.hydrate', 'sessions.messages.subscribe', 'sessions.delete'].includes(request.method)) payload = { ok: true };
      else {
        socket.send(JSON.stringify({ type: 'res', id: request.id, ok: false, error: { code: 'INVALID_REQUEST', message: 'Unexpected Gateway method in storage probe' } }));
        return;
      }
      socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
    });
  });
  child = spawn(nodePath, [entrypoint, 'acp', '--url', `ws://127.0.0.1:${server.address().port}`, '--token', 'clawx-storage-probe-token'], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH, LANG: 'en_US.UTF-8',
      CLAWX_MANAGED_RUNTIME: '1',
      CLAWX_CONVERSATION_STORE_PROTOCOL: 'clawx.conversation-store/v1',
      CLAWX_DISABLE_NATIVE_HISTORY: '1', CLAWX_DISABLE_NATIVE_SCHEDULER: '1',
      OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: join(state, 'openclaw.json'),
      OPENCLAW_CACHE_DIR: cache, OPENCLAW_HISTORY_MODE: 'clawx-data-service',
      OPENCLAW_DISABLE_NATIVE_HISTORY: '1', OPENCLAW_DISABLE_CRON_HISTORY: '1',
      OPENCLAW_SKIP_CRON: '1', OPENCLAW_DISABLE_TRANSCRIPT_USAGE_SCAN: '1',
      OPENCLAW_TRAJECTORY_ENABLED: '0', OPENCLAW_NO_RESPAWN: '1',
      OPENCLAW_EMBEDDED_IN: 'ClawX', OPENCLAW_GATEWAY_TOKEN: 'clawx-storage-probe-token',
      TMPDIR: cache, TMP: cache, TEMP: cache,
    },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
  exited = new Promise(accept => {
    child.once('error', error => { rejectRequests(error); accept(); });
    child.once('exit', (code, signal) => {
      rejectRequests(new Error(`OpenClaw ACP exited (${code ?? signal})`));
      accept();
    });
  });
  lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const response = JSON.parse(line);
      responses.get(response.id)?.settle(response);
    } catch { rejectRequests(new Error('OpenClaw ACP emitted non-JSON stdout')); }
  });
  let sequence = 0;
  const request = (method, params) => new Promise((accept, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { responses.delete(id); reject(new Error(`${method} timed out`)); }, 30000);
    responses.set(id, {
      reject: error => { clearTimeout(timer); reject(error); },
      settle: response => {
        clearTimeout(timer);
        responses.delete(id);
        if (response.error) reject(new Error(`${method}: ${JSON.stringify(response.error)}`));
        else accept(response.result);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'clawx-storage-probe', version: '1' } });
  if (initialized?.protocolVersion !== 1) throw new Error('ACP protocol mismatch');
  const clawx = { protocol: 'clawx.openclaw-session/v1', conversationId: 'probe', runId: 'probe-run', turnId: 'probe-turn', generation: 1, agentId: 'main', history: [], permissionMode: 'read-only' };
  const key = `agent:main:dashboard:incognito-clawx-${createHash('sha256').update(JSON.stringify([clawx.conversationId, clawx.runId, clawx.generation])).digest('hex')}`;
  const created = await request('session/new', { cwd: workspace, mcpServers: [], _meta: managed ? { sessionKey: key, clawx } : { sessionKey: 'agent:main:clawx-storage-probe' } });
  if (typeof created?.sessionId !== 'string' || !created.sessionId) throw new Error('ACP did not create a session');
  if (managed) await request('session/close', { sessionId: created.sessionId });
  await stopChild();

  const databasePath = join(state, 'state', 'openclaw.sqlite');
  const nativeReplayRows = {};
  if (existsSync(databasePath)) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
      for (const table of ['acp_replay_sessions', 'acp_replay_events']) {
        if (tables.has(table)) nativeReplayRows[table] = Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
      }
    } finally { database.close(); }
  }
  const ok = Object.values(nativeReplayRows).every(count => count === 0);
  process.stdout.write(`${JSON.stringify({
    ok, upstreamVersion: metadata.version, entrypoint: entrypoint.slice(packageRoot.length + 1),
    evidenceKind: 'real-acp-simulated-gateway-session-new',
    realGateway: false, providerCalled: false, methods,
    managedDisableFlagsSet: true, nativeReplayRows,
    createdPaths: await readdir(state, { recursive: true }),
  })}\n`);
  if (!ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${stderr}\n`);
  process.exitCode = 1;
} finally {
  rejectRequests(new Error('Storage probe closed'));
  await stopChild();
  lines?.close();
  if (server) {
    for (const socket of server.clients) socket.terminate();
    await new Promise(accept => server.close(accept));
  }
  // Only the fresh fixture directory owned by this invocation is removed.
  await rm(root, { recursive: true, force: true });
}

function rejectRequests(error) {
  for (const pending of responses.values()) pending.reject(error);
  responses.clear();
}

async function stopChild() {
  if (!child || !exited) return;
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}

function required(name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
