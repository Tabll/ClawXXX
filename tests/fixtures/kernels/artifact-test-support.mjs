import { appendFileSync, writeFileSync } from 'node:fs';
import { appendFile, chmod, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// Test-only: the caller owns the mkdtemp root, never a user's installed kernel.
export async function withWritableArtifactFile(ownedRoot, relativePath, mutate) {
  const root = await realpath(ownedRoot);
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes('\\')
    || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Fault injection requires an owned relative regular file');
  }
  let path = root;
  for (const part of relativePath.split('/')) {
    path = resolve(path, part);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Fault injection refuses links');
  }
  const physical = await realpath(path);
  const rel = relative(root, physical);
  const info = await lstat(physical);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)
    || !info.isFile() || info.nlink !== 1) {
    throw new Error('Fault injection requires an owned relative regular file');
  }
  const mode = info.mode & 0o777;
  await chmod(physical, mode | 0o200);
  try {
    await mutate(physical);
  } finally {
    await chmod(physical, mode);
  }
}

export async function injectArtifactCorruption(ownedRoot, relativePath) {
  await withWritableArtifactFile(ownedRoot, relativePath, path =>
    appendFile(path, '\n// clean-machine integrity failure injection\n'));
}

export async function awaitArtifactOperations(operations) {
  const results = await Promise.allSettled(operations);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map(result => result.value);
}

// Only closed test labels and elapsed times are emitted, never error messages,
// filesystem paths, environment variables, credentials or artifact contents.
export function createArtifactTestTrace(evidencePath, write = line => process.stdout.write(line)) {
  const started = performance.now();
  const journal = evidencePath ? `${evidencePath}.progress.jsonl` : undefined;
  if (journal) writeFileSync(journal, '', { mode: 0o600 });
  const phases = new Map();
  let events = 0;
  let stopped = false;
  let failed = false;
  const emit = (phase, status) => {
    if (stopped || events >= 256) return;
    if (!/^[a-z0-9:-]{1,100}$/.test(phase)) throw new Error('Invalid artifact trace phase');
    const line = `${JSON.stringify({
      schemaVersion: 1, event: 'artifact-test-phase', phase, status,
      elapsedMs: Math.round(performance.now() - started),
    })}\n`;
    events += 1;
    if (journal) appendFileSync(journal, line, { mode: 0o600 });
    write(line);
  };
  const heartbeat = setInterval(() => {
    for (const phase of phases.keys()) emit(phase, 'running');
  }, 15_000);
  heartbeat.unref();
  return {
    phase(phase) { emit(phase, 'progress'); },
    async step(phase, operation) {
      phases.set(phase, true);
      emit(phase, 'started');
      try {
        const result = await operation();
        emit(phase, 'passed');
        return result;
      } catch (error) {
        failed = true;
        emit(phase, 'failed');
        throw error;
      } finally {
        phases.delete(phase);
      }
    },
    stop(ok = false) {
      if (stopped) return;
      clearInterval(heartbeat);
      emit('test', ok && !failed ? 'passed' : 'failed');
      stopped = true;
    },
  };
}
