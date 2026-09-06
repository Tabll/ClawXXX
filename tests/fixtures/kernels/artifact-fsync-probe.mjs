// Isolated child process: exercise the real ESM helper with Windows-style
// writable-handle enforcement on every host, plus an injected disk failure.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const [path, fail] = process.argv.slice(2);
const original = { open: fs.openSync, flush: fs.fsyncSync, close: fs.closeSync };
const audit = { flags: [], flushes: 0, closes: 0, error: null };
let targetFd;
let targetFlags;
fs.openSync = (file, flags, ...args) => {
  const fd = original.open(file, flags, ...args);
  if (file === path) {
    targetFd = fd;
    targetFlags = flags;
    audit.flags.push(flags);
  }
  return fd;
};
fs.fsyncSync = (fd) => {
  if (fd === targetFd) {
    audit.flushes += 1;
    if (targetFlags === 'r' || fail === 'true') {
      throw Object.assign(new Error('fixture flush failure'), { code: targetFlags === 'r' ? 'EPERM' : 'EIO' });
    }
  }
  return original.flush(fd);
};
fs.closeSync = (fd) => {
  if (fd === targetFd) audit.closes += 1;
  return original.close(fd);
};
syncBuiltinESMExports();

const { fsyncFile } = await import('../../../scripts/kernel-runtime/lib/artifact.mjs');
try { fsyncFile(path); } catch (error) { audit.error = error.code ?? error.message; }
process.stdout.write(JSON.stringify(audit));
