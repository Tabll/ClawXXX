import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Attach immediately after spawn. Exit does not mean stdout/stderr are drained.
// The original deadline still decides acceptance; a bounded post-kill drain is
// cleanup only and can never turn a timeout into success.
export function collectOpenClawProbe(child, { timeoutMs, killDrainMs = 5000, stdoutLimit = 1024 * 1024, stderrLimit = 32768 } = {}) {
  if (![timeoutMs, killDrainMs, stdoutLimit, stderrLimit].every(value => Number.isInteger(value) && value > 0)) {
    throw new Error('Invalid probe process collection budget');
  }
  return new Promise(resolve => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let failure;
    let spawnError;
    let settled = false;
    let drainTimer;
    const outcome = () => ({
      exitCode: child.exitCode, signal: child.signalCode,
      ...(failure ? { failure } : {}), ...(spawnError ? { spawnError } : {}),
      stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(drainTimer);
      child.off('error', onError);
      child.off('close', finish);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      resolve(outcome());
    };
    const abort = reason => {
      if (failure || settled) return;
      failure = reason;
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, killDrainMs);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const onStdout = chunk => {
      const bytes = Buffer.from(chunk);
      const remaining = stdoutLimit - stdout.length;
      stdout = Buffer.concat([stdout, bytes.subarray(0, Math.max(0, remaining))]);
      if (bytes.length > remaining) abort('stdout-limit');
    };
    const onStderr = chunk => {
      const bytes = Buffer.from(chunk);
      stderr = Buffer.concat([stderr, bytes.subarray(-stderrLimit)]).subarray(-stderrLimit);
    };
    const onError = error => { spawnError = String(error.code ?? error.message); abort('process-error'); };
    const deadline = setTimeout(() => abort('timeout'), timeoutMs);
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('error', onError);
    child.once('close', finish);
  });
}

const PHASES = new Set([
  'prepare', 'project-plugins', 'initial-startup', 'canonical-prompt', 'tool',
  'cancel', 'crash', 'restart', 'channels', 'channel-ingress',
  'channel-rejection', 'storage-scan', 'report', 'cleanup', 'complete', 'failed',
]);

export function createOpenClawProbeTrace(reportPath, { now = () => performance.now(), write = appendFileSync } = {}) {
  const started = now();
  let sequence = 0;
  const path = reportPath ? `${reportPath}.progress.jsonl` : undefined;
  if (path) mkdirSync(dirname(path), { recursive: true });
  return phase => {
    if (!PHASES.has(phase)) throw new Error('Unknown OpenClaw probe phase');
    if (sequence >= 64) throw new Error('OpenClaw probe phase budget exceeded');
    const entry = { schemaVersion: 1, event: 'openclaw-probe-phase', sequence: ++sequence, phase, elapsedMs: Math.max(0, Math.round(now() - started)) };
    if (path) write(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  };
}
