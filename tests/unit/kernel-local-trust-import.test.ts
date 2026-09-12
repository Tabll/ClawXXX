// @vitest-environment node
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clawx-public-trust-import-'));
  roots.push(root);
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const store = { schemaVersion: 1, keys: [{ keyId: 'release-verification', algorithm: 'Ed25519', publicKeyPem: publicKey,
    purposes: ['artifact', 'catalog', 'rollback'], notBefore: '2020-01-01T00:00:00.000Z', notAfter: '2100-01-01T00:00:00.000Z' }] };
  const source = join(root, 'public.json');
  const bytes = JSON.stringify(store);
  writeFileSync(source, bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const output = join(root, 'resources/kernels/trust/roots.production.json');
  const run = (digest = hash) => execFileSync(process.execPath, [resolve('scripts/kernel-runtime/import-local-trust.mjs'),
    '--source', source, '--sha256', digest, '--repository', root], { encoding: 'utf8', stdio: 'pipe' });
  return { run, output, source, hash };
}
describe('local production public trust import', () => {
  it('imports authenticated public keys idempotently', () => {
    const f = fixture();
    expect(JSON.parse(f.run()).ok).toBe(true);
    const bytes = readFileSync(f.output, 'utf8');
    expect(bytes).not.toContain('PRIVATE KEY');
    expect(JSON.parse(f.run()).ok).toBe(true);
    expect(readFileSync(f.output, 'utf8')).toBe(bytes);
  });
  it('rejects a digest mismatch before writing anything', () => {
    const f = fixture();
    expect(() => f.run('0'.repeat(64))).toThrow('SHA-256 mismatch');
    expect(existsSync(f.output)).toBe(false);
  });
  it('does not replace different existing roots or accept private key material', () => {
    const f = fixture();
    f.run();
    writeFileSync(f.output, '{"schemaVersion":1,"keys":[]}');
    expect(() => f.run()).toThrow('reviewed rotation');
    const privateText = '-----BEGIN PRIVATE KEY-----';
    writeFileSync(f.source, privateText);
    expect(() => f.run(createHash('sha256').update(privateText).digest('hex'))).toThrow('Only bounded public trust roots');
    expect(readFileSync(f.output, 'utf8')).toBe('{"schemaVersion":1,"keys":[]}');
  });
  it('rejects base64-encoded private keys instead of deriving and trusting their public key', () => {
    const f = fixture();
    const store = JSON.parse(readFileSync(f.source, 'utf8'));
    delete store.keys[0].publicKeyPem;
    store.keys[0].publicKeyB64 = Buffer.from(generateKeyPairSync('ed25519').privateKey
      .export({ format: 'pem', type: 'pkcs8' })).toString('base64');
    const bytes = JSON.stringify(store);
    writeFileSync(f.source, bytes);
    expect(() => f.run(createHash('sha256').update(bytes).digest('hex'))).toThrow('Only public key PEM');
    expect(existsSync(f.output)).toBe(false);
  });
});
