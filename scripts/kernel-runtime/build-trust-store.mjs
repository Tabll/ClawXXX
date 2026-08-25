#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalJson } from './lib/canonical.mjs';
import { buildTrustStoreFromBundle } from './lib/trust-store.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const output = resolve(required('--output'));
const channel = args.get('--channel') ?? 'production';
if (channel !== 'production' && channel !== 'staging') throw new Error('Trust-store channel must be production or staging');
if (existsSync(output)) throw new Error(`Trust-store output is immutable: ${output}`);
const store = buildTrustStoreFromBundle(process.env.CLAWX_KERNEL_TRUST_KEYS_B64, {
  channel,
  now: args.get('--at') ? new Date(args.get('--at')) : new Date(),
});
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
writeFileSync(output, `${canonicalJson(store)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
process.stdout.write(`${JSON.stringify({ ok: true, channel, output, keys: store.keys.map(key => key.keyId) })}\n`);

function required(name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
