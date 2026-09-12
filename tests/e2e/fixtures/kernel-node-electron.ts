/** Real Electron Main + production Gateway launcher; never imports mock runtime APIs. */
import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync, backup } from 'node:sqlite';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { launchGatewayProcess } from '../../../electron/gateway/process-launcher';
import { terminateOwnedGatewayProcess } from '../../../electron/gateway/supervisor';
import { probeGatewayReady } from '../../../electron/gateway/ws-client';
import { resolveDevelopmentKernelNode } from '../../../electron/kernels/node-runtime';
import { buildManagedOpenClawEnvironment, configureOpenClawRuntimeLocation,
  createDevelopmentOpenClawRuntimeLocation, ensureManagedOpenClawDataRoots } from '../../../electron/kernels/openclaw/runtime-location';
import { projectOpenClawConfigForRuntime } from '../../../electron/gateway/config-projection';
import type { GatewayLaunchContext } from '../../../electron/gateway/config-sync';
import { writeAuthProfilesToSqlite } from '../../../electron/utils/openclaw-auth-sqlite';

const execute = promisify(execFile);
const root = process.env.CLAWX_NODE_TEST_ROOT!;
const repository = process.env.CLAWX_NODE_TEST_REPOSITORY!;
if (!root || !repository) throw new Error('Isolated test root and repository are required');
app.setPath('userData', join(root, 'electron-data'));
const node = resolveDevelopmentKernelNode(repository);
const location = createDevelopmentOpenClawRuntimeLocation({
  packageDir: join(repository, 'node_modules/openclaw'), userDataRoot: root,
  artifactVersion: 'real-node-regression', nodeExecutable: node,
});
configureOpenClawRuntimeLocation(location);
ensureManagedOpenClawDataRoots(location);
const databasePath = join(location.stateRoot, 'state/openclaw.sqlite');
const agentDatabasePath = join(location.stateRoot, 'agents/main/agent/openclaw-agent.sqlite');
const children = new Set<ChildProcess>();
const evidence = { electron: process.versions.electron, node, databasePath, phases: [] as string[], logs: '' };
let running: ChildProcess | undefined;
let port = 0;
let shouldReconnect = true;
const addLog = (line: string) => { evidence.logs = `${evidence.logs}${line}\n`.slice(-20_000); };

async function seed() {
  // Match the host's installed-plugin projection: a real existing native DB,
  // not a dummy file and not the canonical conversations database.
  mkdirSync(dirname(databasePath), { recursive: true });
  const schema = readFileSync(join(repository, 'electron/utils/plugin-install-index.ts'), 'utf8')
    .match(/const INSTALLED_PLUGIN_INDEX_TABLE_SQL = `([\s\S]*?)`;/)?.[1];
  if (!schema) throw new Error('Native plugin index schema changed');
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(schema);
    db.exec('CREATE TABLE clawx_node_regression_marker (value TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO clawx_node_regression_marker VALUES (?)').run('PRESERVE_EXISTING_STATE');
  } finally { db.close(); }
  const reservation = createServer();
  await new Promise<void>((accept, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', accept); });
  port = (reservation.address() as { port: number }).port;
  await new Promise<void>((accept, reject) => reservation.close(error => error ? reject(error) : accept()));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(location.stateRoot, 'openclaw.json'), JSON.stringify(projectOpenClawConfigForRuntime({
    logging: { file: join(location.cacheRoot, 'gateway.log') },
    gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token', token: 'clawx-isolated-regression-token' }, controlUi: { enabled: false } },
    agents: { ownership: 'explicit', defaults: { systemAgent: { agentId: 'main' }, heartbeat: { every: '0m' } }, entries: { main: { workspace } } },
    plugins: { enabled: false }, cron: { enabled: false },
  }, true)));
  if (process.env.CLAWX_NODE_TEST_EXISTING_AGENT_DATABASE) {
    // Optional local incident replay: snapshot the repaired copy, never open
    // the caller's database writable and never persist its credentials in logs.
    mkdirSync(dirname(agentDatabasePath), { recursive: true, mode: 0o700 });
    const source = new DatabaseSync(process.env.CLAWX_NODE_TEST_EXISTING_AGENT_DATABASE, { readOnly: true });
    try { await backup(source, agentDatabasePath); } finally { source.close(); }
    evidence.phases.push('existing-agent-snapshot-restored');
  }
  // Exercise the actual host credential sync that used to stamp schema v1.
  // Synthetic auth replaces any incident-copy credentials before Gateway starts.
  await syncAuth();
  const agentDb = new DatabaseSync(agentDatabasePath);
  try {
    agentDb.prepare('INSERT INTO cache_entries(scope,key,value_json,updated_at) VALUES (?,?,?,?)')
      .run('clawx-regression', 'preserve', '{"marker":"PRESERVE_AGENT_STATE"}', 1);
  } finally { agentDb.close(); }
  evidence.phases.push('existing-sqlite-seeded');
  return { databasePath, marker: inspect(), agent: inspectAgent(), node };
}

async function syncAuth() {
  await writeAuthProfilesToSqlite({ version: 1, profiles: {
    'clawx-synthetic:default': { type: 'api_key', provider: 'clawx-synthetic', key: 'isolated-no-provider-request' },
  } }, 'main');
  evidence.phases.push('host-auth-synchronized');
  return inspectAgent();
}

function inspectAgent() {
  const db = new DatabaseSync(agentDatabasePath, { readOnly: true });
  try {
    return { version: db.prepare('PRAGMA user_version').get()?.user_version,
      metadata: db.prepare("SELECT schema_version, agent_id, app_version, created_at FROM schema_meta WHERE meta_key='primary'").get(),
      marker: db.prepare("SELECT value_json FROM cache_entries WHERE scope='clawx-regression' AND key='preserve'").get()?.value_json,
      integrity: db.prepare('PRAGMA quick_check').get()?.quick_check,
      foreignKeyErrors: db.prepare('PRAGMA foreign_key_check').all().length };
  } finally { db.close(); }
}

function inspect() {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return { marker: db.prepare('SELECT value FROM clawx_node_regression_marker').get()?.value,
      integrity: db.prepare('PRAGMA quick_check').get()?.quick_check };
  } finally { db.close(); }
}

async function start() {
  if (running) throw new Error('Test Gateway already running');
  shouldReconnect = true;
  await syncAuth();
  const env = buildManagedOpenClawEnvironment(location, {
    PATH: dirname(node), LANG: 'en_US.UTF-8',
    SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT,
    HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_GATEWAY_TOKEN: 'clawx-isolated-regression-token',
  });
  // Poison inherited Electron-only settings: the production launcher must
  // remove these even when a caller supplies an unsanitized launch context.
  const forkEnv = { ...env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require nonexistent-host-preload.cjs', NODE_PATH: '/invalid-host-node-path' };
  const context = {
    openclawDir: location.packageDir, entryScript: location.entryPath,
    gatewayArgs: ['gateway', 'run', '--port', String(port), '--bind', 'loopback'],
    forkEnv, mode: 'dev', binPathExists: false, loadedProviderKeyCount: 0,
    channelStartupSummary: 'skipped(test-isolation)', proxySummary: 'disabled',
  } as GatewayLaunchContext;
  const launched = await launchGatewayProcess({
    port, launchContext: context, sanitizeSpawnArgs: args => args,
    getCurrentState: () => 'starting', getShouldReconnect: () => shouldReconnect,
    onStderrLine: addLog, onSpawn: () => {}, onError: error => addLog(error.message),
    onExit: (_child, code) => addLog(`Gateway exit=${code}`),
  });
  running = launched.child;
  children.add(running);
  running.stdout?.on('data', bytes => addLog(String(bytes)));
  running.once('exit', () => children.delete(launched.child));
  evidence.phases.push('gateway-spawned');
  return { pid: running.pid, port, spawnfile: running.spawnfile, spawnargs: running.spawnargs };
}

async function stop() {
  shouldReconnect = false;
  if (running) await terminateOwnedGatewayProcess(running);
  const exitCode = running?.exitCode;
  const signal = running?.signalCode;
  running = undefined;
  evidence.phases.push('gateway-stopped');
  return { exitCode, signal, activeChildren: children.size, ...inspect(), agent: inspectAgent() };
}

async function worker() {
  // Use the real Node-selected CLI worker (same file seen in the incident).
  const { stdout } = await execute(node, [join(location.packageDir, 'dist/infra/sqlite-readonly-location.worker.js'),
    '--openclaw-sqlite-readonly-child', 'async', databasePath],
  { env: buildManagedOpenClawEnvironment(location, { PATH: dirname(node), SystemRoot: process.env.SystemRoot,
    HOME: root, USERPROFILE: root }), windowsHide: true, timeout: 30_000 });
  return JSON.parse(stdout) as { ok: boolean; location?: string };
}

async function identity() {
  const { stdout } = await execute(node, ['-e', `const cp = require('node:child_process');
    const code = 'JSON.stringify({node:process.versions.node,electron:process.versions.electron,execPath:process.execPath})';
    process.stdout.write(cp.execFileSync(process.execPath, ['-p', code], {encoding:'utf8'}));`],
  { env: buildManagedOpenClawEnvironment(location, { PATH: dirname(node), SystemRoot: process.env.SystemRoot }), windowsHide: true, timeout: 15_000 });
  return JSON.parse(stdout);
}

app.on('before-quit', () => { for (const child of children) child.kill(); });
Object.assign(globalThis, { kernelNodeRegression: { seed, start, stop, worker, identity, syncAuth, evidence,
  ready: () => probeGatewayReady(port, 2000),
  status: () => ({ exitCode: running?.exitCode, signalCode: running?.signalCode, activeChildren: children.size }) } });
void app.whenReady();
