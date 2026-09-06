#!/usr/bin/env node
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const payload = resolve(required('--payload'));
const platform = required('--platform');
const arch = required('--arch');
if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Invalid native target');
if (!existsSync(payload) || payload === resolve(sep)) throw new Error('Payload root is missing or unsafe');

const aliases = { darwin: 'darwin', mac: 'darwin', linux: 'linux', linuxmusl: 'linux', win32: 'win32', win: 'win32', windows: 'win32' };
const scopes = {
  '@napi-rs': /^canvas-(darwin|linux|win32)-(x64|arm64)/,
  '@img': /^sharp(?:-libvips)?-(darwin|linux(?:musl)?|win32)-(x64|arm64|arm|ppc64|riscv64|s390x)/,
  '@mariozechner': /^clipboard-(darwin|linux|win32)-(x64|arm64|universal)/,
  '@snazzah': /^davey-(darwin|linux|android|freebsd|win32|wasm32)-(x64|arm64|arm|ia32)/,
  '@lydell': /^node-pty-(darwin|linux|win32)-(x64|arm64)/,
  '@reflink': /^reflink-(darwin|linux|win32)-(x64|arm64)/,
  '@node-llama-cpp': /^(mac|linux|win)-(arm64|x64|armv7l)/,
  '@esbuild': /^(darwin|linux|win32|android|freebsd|netbsd|openbsd|sunos|aix|openharmony)-(x64|arm64|arm|ia32|loong64|mips64el|ppc64|riscv64|s390x)/,
  '@openai': /^codex-(darwin|linux|win32)-(x64|arm64)$/,
  '@koromix': /^koffi-(darwin|linux|win32|freebsd|openbsd)-(x64|arm64|arm|ia32|loong64|riscv64)$/,
  '@deepseek-ai': /^node-addon-landlock-run-(linux)-(x64|arm64)$/,
};
let removed = 0;
for (const nodeModules of findDirectories(payload, 'node_modules')) {
  for (const [scope, pattern] of Object.entries(scopes)) {
    const scopeRoot = join(nodeModules, scope);
    if (!existsSync(scopeRoot)) continue;
    for (const entry of readdirSync(scopeRoot)) {
      const match = pattern.exec(entry);
      if (!match) continue;
      const candidatePlatform = aliases[match[1]] ?? match[1];
      const candidateArch = match[2].split('-')[0];
      if (candidatePlatform !== platform || (candidateArch !== arch && candidateArch !== 'universal')) remove(join(scopeRoot, entry));
    }
  }
  for (const entry of readdirSync(nodeModules)) {
    const match = /^sqlite-vec-(darwin|linux|windows)-(x64|arm64)$/.exec(entry);
    if (match && (aliases[match[1]] !== platform || match[2] !== arch)) remove(join(nodeModules, entry));
    const builtin = /^node-addon-require-builtin-(darwin|linux|win32)-(x64|arm64|ia32)(?:-(gnu|msvc))?$/.exec(entry);
    if (builtin && (builtin[1] !== platform || builtin[2] !== arch)) remove(join(nodeModules, entry));
  }
  const koffi = join(nodeModules, 'koffi', 'build', 'koffi');
  if (existsSync(koffi)) {
    for (const entry of readdirSync(koffi)) if (entry !== `${platform}_${arch}`) remove(join(koffi, entry));
  }
  // Scoped Koffi Linux packages ship both glibc and musl in one package.
  // ClawX's independent Node distribution and support contract are glibc-only.
  const scopedKoffiMusl = join(nodeModules, '@koromix', `koffi-linux-${arch}`, `musl_${arch}`);
  if (platform === 'linux' && existsSync(scopedKoffiMusl)) remove(scopedKoffiMusl);
  for (const packageName of ['tree-sitter-bash', 'node-pty']) {
    const prebuilds = join(nodeModules, packageName, 'prebuilds');
    if (!existsSync(prebuilds)) continue;
    for (const entry of readdirSync(prebuilds)) {
      const normalized = entry.replace(/^mac-/, 'darwin-').replace(/^win-/, 'win32-');
      if (!normalized.startsWith(`${platform}-${arch}`)) remove(join(prebuilds, entry));
    }
  }
  const conpty = join(nodeModules, 'node-pty', 'third_party', 'conpty');
  if (existsSync(conpty)) {
    if (platform !== 'win32') remove(conpty);
    else {
      for (const version of readdirSync(conpty, { withFileTypes: true })) {
        if (!version.isDirectory()) continue;
        for (const target of readdirSync(join(conpty, version.name), { withFileTypes: true })) {
          if (target.isDirectory() && target.name !== `win10-${arch}`) remove(join(conpty, version.name, target.name));
        }
      }
    }
  }
}
process.stdout.write(`${JSON.stringify({ ok: true, platform, arch, removed })}\n`);

function findDirectories(root, name) {
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (entry.name === name) found.push(path);
      else visit(path);
    }
  };
  visit(root);
  return found;
}

function remove(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
  removed += 1;
}

function required(key) {
  const value = args.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
