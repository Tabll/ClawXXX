import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildManagedOpenClawEnvironment, requireOpenClawRuntimeLocation } from '../kernels/openclaw/runtime-location';

const RESULT_PREFIX = 'CLAWX_AGENT_AUTH_RESULT=';
const MAX_PAYLOAD_BYTES = 1024 * 1024;

// Schema creation, admission checks and leases belong to the selected kernel.
// Never bootstrap a partial Agent schema or write its version markers in Main.
// Credentials travel on stdin only, never argv, environment or diagnostic logs.
const AUTH_WRITER_SOURCE = `
const prefix = ${JSON.stringify(RESULT_PREFIX)};
let phase = 'input';
function finish(result) {
  process.stdout.write(prefix + JSON.stringify(result) + '\\n', () => process.exit(result.ok ? 0 : 1));
}
try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > ${MAX_PAYLOAD_BYTES}) throw new Error('payload limit');
    chunks.push(chunk);
  }
  const { secrets, state } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!secrets || typeof secrets !== 'object' || !secrets.profiles || typeof secrets.profiles !== 'object') throw new Error('invalid payload');
  phase = 'admission';
  const sdk = await import(process.argv[1]);
  const database = sdk.openOpenClawAgentDatabase({ agentId: process.argv[2], path: process.argv[3], env: process.env });
  phase = 'transaction';
  sdk.runSqliteImmediateTransactionSync(database.db, () => {
    const now = Date.now();
    database.db.prepare('INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(store_key) DO UPDATE SET store_json=excluded.store_json, updated_at=excluded.updated_at')
      .run('primary', JSON.stringify(secrets), now);
    if (state) database.db.prepare('INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(state_key) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at')
      .run('primary', JSON.stringify(state), now);
    else database.db.prepare('DELETE FROM auth_profile_state WHERE state_key=?').run('primary');
  });
  finish({ ok: true });
} catch (error) {
  // JSON/SQL errors can contain credential data. Emit only bounded classifications.
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(error.code) ? error.code : 'agent_auth_write_failed';
  finish({ ok: false, phase, code });
}
`;

export async function writeOpenClawAgentAuth(
  agentId: string,
  secrets: Record<string, unknown>,
  state: Record<string, unknown> | null,
): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(agentId)) throw new Error('Invalid OpenClaw agent ID');
  const location = requireOpenClawRuntimeLocation();
  const sqlitePath = join(location.stateRoot, 'agents', agentId, 'agent', 'openclaw-agent.sqlite');
  const sdkUrl = pathToFileURL(join(location.packageDir, 'dist/plugin-sdk/sqlite-runtime.js')).href;
  const input = JSON.stringify({ secrets, state });
  if (Buffer.byteLength(input) > MAX_PAYLOAD_BYTES) throw new Error('OpenClaw auth payload exceeds 1 MiB');
  await new Promise<void>((resolve, reject) => {
    const child = execFile(location.nodeExecutable,
      ['--input-type=module', '--eval', AUTH_WRITER_SOURCE, sdkUrl, agentId, sqlitePath],
      { cwd: location.packageDir, env: buildManagedOpenClawEnvironment(location), windowsHide: true,
        timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        const line = stdout.split(/\r?\n/).reverse().find(value => value.startsWith(RESULT_PREFIX));
        let result: { ok?: boolean; phase?: string; code?: string } | undefined;
        try { result = line ? JSON.parse(line.slice(RESULT_PREFIX.length)) : undefined; } catch { /* fail closed */ }
        if (!error && result?.ok === true) resolve();
        else reject(new Error(`OpenClaw Agent auth write failed (${result?.phase ?? 'process'} / ${result?.code ?? 'worker_failed'}); database schema is kernel-owned and may require offline repair.`));
      });
    child.stdin?.on('error', () => { /* execFile close/error reports the failed worker */ });
    child.stdin?.end(input);
  });
}
