import { strict as assert } from 'node:assert';
import tar from 'tar';

// The production floor is intentionally not imported: these boundary fixtures
// must fail if the signed extraction policy is accidentally widened or narrowed.
export const signedFileCount = 1;
export const signedFileBytes = 1;
export const streamBudget = 10 * 1024 * 1024 + signedFileBytes;
const postEofBytes = 64 * 1024;
const recordBytes = 64 * 1024;

function fileAndEof() {
  const header = new tar.Header({
    path: 'runtime/benign', type: 'File', size: signedFileBytes,
    mode: 0o644, uid: 0, gid: 0, mtime: new Date(0),
  });
  header.encode();
  const body = Buffer.alloc(512);
  body.write('x');
  return Buffer.concat([header.block, body, Buffer.alloc(1_024)]);
}

function paxRecord(length) {
  // Each metadata body remains well below tar's default 1 MiB metadata limit.
  // A comment fills complete records; only one regular file reaches TarGuard.
  const record = new tar.Pax({
    path: 'runtime/file', mtime: new Date(0),
    comment: 'x'.repeat(length - 1_024),
  }).encode();
  assert.equal(record.length, length);
  return record;
}

export function archiveOverheadFixture(excessBytes = 0) {
  assert.ok(excessBytes === 0 || excessBytes === 1);
  const ending = fileAndEof();
  let remaining = streamBudget - signedFileBytes - postEofBytes - ending.length;
  const parts = [];
  const fullRecord = paxRecord(recordBytes);
  while (remaining >= recordBytes) {
    parts.push(fullRecord);
    remaining -= recordBytes;
  }
  if (remaining > 0) parts.push(paxRecord(remaining));
  const bytes = Buffer.concat([
    ...parts, ending, Buffer.alloc(postEofBytes + signedFileBytes + excessBytes),
  ]);
  assert.equal(bytes.length, streamBudget + excessBytes);
  return bytes;
}

// Retain the previous fixture only for an explicit offline diagnostic. CI uses
// the bounded fixture above, never this quadratic post-EOF buffering workload.
export function legacyArchiveOverheadFixture() {
  return Buffer.concat([
    new tar.Pax({ path: 'runtime/file', size: signedFileBytes }).encode(),
    fileAndEof(), Buffer.alloc(11 * 1024 * 1024),
  ]);
}
