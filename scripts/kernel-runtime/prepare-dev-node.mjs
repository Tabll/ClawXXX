#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const config = JSON.parse(readFileSync(join(repository, 'kernels/node-runtime.json'), 'utf8'));
const asset = config.assets.find(item => item.platform === process.platform && item.arch === process.arch);
if (!asset) throw new Error(`No pinned kernel Node runtime for ${process.platform}-${process.arch}`);
const destination = join(repository, 'temp/kernel-node', config.version, `${process.platform}-${process.arch}`);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));
if (!existsSync(destination)) {
  execFileSync(process.execPath, [join(repository, 'scripts/kernel-runtime/download-node-runtime.mjs'),
    '--platform', process.platform, '--arch', process.arch, '--destination', destination,
    '--repository', repository], { env, stdio: 'inherit' });
}
const receipt = JSON.parse(readFileSync(join(destination, 'CLAWX_NODE_RUNTIME.json'), 'utf8'));
if (receipt.version !== config.version || receipt.moduleAbi !== config.moduleAbi
  || receipt.platform !== process.platform || receipt.arch !== process.arch
  || receipt.sourceSha256 !== asset.sha256) {
  throw new Error(`Invalid kernel Node receipt at ${destination}; refusing to overwrite an existing runtime`);
}
const executable = join(destination, process.platform === 'win32' ? 'node.exe' : 'bin/node');
const identity = JSON.parse(execFileSync(executable, ['-p',
  'JSON.stringify({node:process.versions.node,abi:Number(process.versions.modules),electron:process.versions.electron,arch:process.arch,platform:process.platform})'],
{ env, encoding: 'utf8', timeout: 15_000, windowsHide: true }));
if (identity.node !== config.version || identity.abi !== config.moduleAbi || identity.electron
  || identity.platform !== process.platform || identity.arch !== process.arch) {
  throw new Error('Kernel Node executable does not match its pinned identity');
}
console.log(`Kernel Node ${identity.node} (${identity.platform}-${identity.arch}, ABI ${identity.abi}) ready`);
