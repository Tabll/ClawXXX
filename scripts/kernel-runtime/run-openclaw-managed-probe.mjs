#!/usr/bin/env node
// Preserve native status before Git Bash can map an NTSTATUS crash to 127.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openClawProbeBudgets } from './lib/openclaw-probe-lifecycle.mjs';
import { collectOpenClawProbe } from './lib/openclaw-probe-process.mjs';

export async function runOpenClawManagedProbe({ nodePath, packageDir, pluginsRoot, reportPath }, { spawnProbe = spawn } = {}) {
  if (![nodePath, packageDir, pluginsRoot, reportPath].every(value => typeof value === 'string' && value.length > 0)) {
    throw new Error('Managed probe requires node, package, plugins and report paths');
  }
  const expectedVersion = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version;
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
  const probe = spawnProbe(nodePath, [
    resolve('scripts/kernel-runtime/probe-openclaw-managed-runtime.mjs'),
    '--package-dir', packageDir, '--node', nodePath, '--plugins-root', pluginsRoot, '--report', reportPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const result = await collectOpenClawProbe(probe, { timeoutMs: openClawProbeBudgets().totalMs });
  const exitCodeHex = Number.isInteger(result.exitCode) ? `0x${(result.exitCode >>> 0).toString(16)}` : null;
  writeFileSync(`${reportPath}.process.json`, `${JSON.stringify({ ...result, exitCodeHex }, null, 2)}\n`, { mode: 0o600 });
  if (result.failure || result.exitCode !== 0 || result.signal !== null) {
    throw new Error(`OpenClaw real Gateway/ACP probe failed (code=${result.exitCode}/${exitCodeHex}, signal=${result.signal}, reason=${result.failure ?? 'exit'}, spawn=${result.spawnError ?? 'none'}): ${result.stderr}`);
  }
  const report = JSON.parse(result.stdout);
  if (report.ok !== true || report.version !== expectedVersion || report.nativeDurableHistory !== false) {
    throw new Error('OpenClaw real runtime evidence is invalid');
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const required = name => {
    const value = args.get(name);
    if (!value) throw new Error(`Missing ${name}`);
    return resolve(value);
  };
  const report = await runOpenClawManagedProbe({
    nodePath: required('--node'), packageDir: required('--package-dir'),
    pluginsRoot: required('--plugins-root'), reportPath: required('--report'),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
