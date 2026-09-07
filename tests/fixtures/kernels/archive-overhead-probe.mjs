import { performance } from 'node:perf_hooks';
import tar from 'tar';
import { archiveOverheadFixture, legacyArchiveOverheadFixture, streamBudget } from './archive-overhead.mjs';

const legacy = process.argv.includes('--legacy');
const bytes = legacy ? legacyArchiveOverheadFixture() : archiveOverheadFixture();
const originalConcat = Buffer.concat;
let concatenatedBytes = 0;
let concatenations = 0;
let entries = 0;
const start = performance.now();
try {
  // Count bytes copied, not wall time. Run in a dedicated process so the scoped
  // Buffer instrumentation cannot observe Vitest or other tests' allocations.
  Buffer.concat = function (list, totalLength) {
    concatenations += 1;
    concatenatedBytes += totalLength ?? list.reduce((total, chunk) => total + chunk.length, 0);
    return originalConcat(list, totalLength);
  };
  const listing = tar.t({ strict: true, onentry() { entries += 1; } });
  const done = new Promise((accept, reject) => {
    listing.on('end', accept);
    listing.on('error', reject);
  });
  // Match Zstandard's default 16 KiB output chunks, stopping at the same
  // boundary as the real pre-parser limiter would for an oversized archive.
  for (let offset = 0; offset < Math.min(bytes.length, streamBudget); offset += 16 * 1024) {
    listing.write(bytes.subarray(offset, Math.min(offset + 16 * 1024, streamBudget)));
  }
  listing.end();
  await done;
} finally {
  Buffer.concat = originalConcat;
}
console.log(JSON.stringify({
  legacy, archiveBytes: bytes.length, entries, concatenations, concatenatedBytes,
  copyAmplification: concatenatedBytes / streamBudget,
  elapsedMs: Math.round(performance.now() - start),
}));
