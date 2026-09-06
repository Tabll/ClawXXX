#!/usr/bin/env node
import { resolve } from 'node:path';
import { assembleKernelArtifact } from './lib/artifact.mjs';
import { readPrivateKeyFromEnvironment } from './lib/signing.mjs';
import { verifySourceInputs } from './lib/source-manifest.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const required = [
  '--kernel', '--platform', '--arch', '--payload', '--node', '--tests', '--storage', '--licenses',
  '--platform-security', '--output', '--base-url',
];
for (const argument of required) if (!args.get(argument)) throw new Error(`Missing ${argument}`);
const repositoryRoot = resolve(args.get('--repository') ?? process.cwd());
verifySourceInputs({
  repositoryRoot,
  kernelId: args.get('--kernel'),
  sourceCheckout: args.get('--source-checkout'),
  sourceCheckoutState: 'prepared',
});
const result = await assembleKernelArtifact({
  repositoryRoot,
  kernelId: args.get('--kernel'),
  platform: args.get('--platform'),
  arch: args.get('--arch'),
  payloadDir: resolve(args.get('--payload')),
  nodeDir: resolve(args.get('--node')),
  nodeDistributionSha256: args.get('--node-sha256'),
  testReportPath: resolve(args.get('--tests')),
  storageReportPath: resolve(args.get('--storage')),
  licenseReportPath: resolve(args.get('--licenses')),
  platformSecurityReportPath: resolve(args.get('--platform-security')),
  outputDir: resolve(args.get('--output')),
  artifactBaseUrl: args.get('--base-url'),
  artifactSigningKeyId: process.env.CLAWX_ARTIFACT_SIGNING_KEY_ID,
  artifactSigningPrivateKey: readPrivateKeyFromEnvironment('CLAWX_ARTIFACT_SIGNING_PRIVATE_KEY_B64'),
});
process.stdout.write(`${JSON.stringify({
  ok: true,
  archive: result.archivePath,
  descriptor: result.descriptorPath,
  sha256: result.descriptor.archive.sha256,
})}\n`);
