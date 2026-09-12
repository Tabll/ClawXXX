import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import nodeRuntime from '../../kernels/node-runtime.json';
import { getPathEnvValue, prependPathEntry } from '../utils/env-path';

/** The dev launcher is prepared from the same reviewed pin as CI artifacts. */
export function resolveDevelopmentKernelNode(projectRoot: string): string {
  const target = `${process.platform}-${process.arch}`;
  const root = join(projectRoot, 'temp', 'kernel-node', nodeRuntime.version, target);
  const executable = join(root, process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const asset = nodeRuntime.assets.find(item => `${item.platform}-${item.arch}` === target);
  const fail = () => new Error('Pinned kernel Node runtime is missing or invalid. Run pnpm run kernel:dev:prepare before starting Electron.');
  if (!asset || !existsSync(executable)) throw fail();
  try {
    const receipt = JSON.parse(readFileSync(join(root, 'CLAWX_NODE_RUNTIME.json'), 'utf8'));
    if (receipt.version !== nodeRuntime.version || receipt.moduleAbi !== nodeRuntime.moduleAbi
      || receipt.platform !== process.platform || receipt.arch !== process.arch
      || receipt.sourceSha256 !== asset.sha256) throw fail();
  } catch {
    throw fail();
  }
  return executable;
}

/** Do not let Electron flags or host preloads leak into native Node children. */
export function buildKernelNodeEnvironment(
  nodeExecutable: string,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!isAbsolute(nodeExecutable)) throw new Error('Kernel Node executable must be an absolute path');
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^(?:ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) delete env[key];
  }
  // Both process.execPath workers and tools invoking `node` use this runtime.
  return getPathEnvValue(env).split(delimiter)[0] === dirname(nodeExecutable)
    ? env : prependPathEntry(env, dirname(nodeExecutable)).env;
}
