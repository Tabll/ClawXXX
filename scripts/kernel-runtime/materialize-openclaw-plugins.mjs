#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const payload = resolve(required('--payload'));
const repository = resolve(args.get('--repository') ?? process.cwd());
const destination = join(payload, 'clawx-plugins');
if (existsSync(destination)) throw new Error(`OpenClaw plugin payload already exists: ${destination}`);
mkdirSync(destination, { recursive: true, mode: 0o700 });

const sources = [
  join(repository, 'build', 'openclaw-plugins'),
  join(repository, 'resources', 'openclaw-plugins'),
];
let copied = 0;
for (const sourceRoot of sources) {
  if (!existsSync(sourceRoot)) continue;
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = join(destination, basename(entry.name));
    if (existsSync(target)) throw new Error(`Duplicate OpenClaw plugin mirror: ${entry.name}`);
    cpSync(join(sourceRoot, entry.name), target, { recursive: true, dereference: true, errorOnExist: true });
    copied += 1;
  }
}
if (copied < 8) throw new Error(`Expected seven channel plugins and one ClawX plugin, copied ${copied}`);
process.stdout.write(`${JSON.stringify({ ok: true, destination, plugins: copied })}\n`);

function required(name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
