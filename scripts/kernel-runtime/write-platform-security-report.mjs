#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readJson, writeCanonicalJson } from './lib/canonical.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const platform = required('--platform');
const arch = required('--arch');
const output = resolve(required('--output'));
const windowsSigning = args.get('--windows-signing') ?? 'authenticode';
if (!['authenticode', 'artifact-signature-only'].includes(windowsSigning)
  || (args.has('--windows-signing') && platform !== 'win32')) {
  throw new Error('Invalid Windows code-signing policy');
}
let report;
if (platform === 'darwin') {
  const signing = successful('--signing');
  const notarization = readJson(resolve(required('--notarization')));
  if (signing.platform !== 'darwin' || !Array.isArray(signing.files) || signing.files.length === 0) {
    throw new Error('macOS signing report is incomplete');
  }
  if (notarization.status !== 'Accepted' || typeof notarization.id !== 'string') {
    throw new Error(`macOS runtime notarization was not accepted: ${JSON.stringify(notarization)}`);
  }
  report = {
    schemaVersion: 1, ok: true, platform, arch,
    codeSigning: { hardenedRuntime: true, files: signing.files },
    notarization: { status: notarization.status, submissionId: notarization.id },
  };
} else if (platform === 'win32' && windowsSigning === 'artifact-signature-only') {
  if (args.has('--signing')) throw new Error('Deferred Authenticode must not consume a signing report');
  report = {
    schemaVersion: 1, ok: true, platform, arch,
    codeSigning: { authenticode: false, artifactSignatureOnly: true, status: 'deferred' },
  };
} else if (platform === 'win32') {
  const signing = successful('--signing');
  if (signing.platform !== 'win32' || !Array.isArray(signing.files) || signing.files.length === 0) {
    throw new Error('Windows Authenticode report is incomplete');
  }
  report = {
    schemaVersion: 1, ok: true, platform, arch,
    codeSigning: { authenticode: true, digestAlgorithm: 'SHA256', files: signing.files },
  };
} else if (platform === 'linux') {
  report = {
    schemaVersion: 1, ok: true, platform, arch,
    codeSigning: { artifactSignatureOnly: true },
    compatibility: {
      distribution: 'Ubuntu 24.04 LTS or ABI-compatible newer distribution',
      minimumGlibc: '2.39',
      minimumKernel: '6.8',
      libc: 'glibc',
      muslSupported: false,
      sandbox: 'Electron user namespaces/AppArmor policy and kernel-driver workspace policy required',
    },
  };
} else {
  throw new Error(`Unsupported platform security report target: ${platform}`);
}
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
writeCanonicalJson(output, report);
process.stdout.write(`${JSON.stringify({ ok: true, platform, arch, output })}\n`);

function successful(name) {
  const value = readJson(resolve(required(name)));
  if (value?.ok !== true) throw new Error(`${name} report is not successful`);
  return value;
}

function required(name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
