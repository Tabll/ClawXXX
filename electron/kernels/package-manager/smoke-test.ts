import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { KernelArtifactDescriptorV1 } from '@shared/kernels/catalog';
import { KernelPackageError } from './errors';

export type KernelSmokeTestReport = {
  readyMs: number;
  rssBytes: number;
  pid: number;
};

export interface KernelSmokeTester {
  test(installRoot: string, descriptor: KernelArtifactDescriptorV1): Promise<KernelSmokeTestReport>;
}

export class ControlBridgeSmokeTester implements KernelSmokeTester {
  async test(installRoot: string, descriptor: KernelArtifactDescriptorV1): Promise<KernelSmokeTestReport> {
    const nodePath = resolve(installRoot, 'runtime', 'node', descriptor.platform === 'win32' ? 'node.exe' : join('bin', 'node'));
    const controlPath = resolve(installRoot, descriptor.entrypoints.control);
    const scratch = await mkdtemp(join(tmpdir(), 'clawx-kernel-smoke-'));
    const dataDir = join(scratch, 'data');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const startedAt = performance.now();
    const child = spawn(nodePath, [controlPath], {
      cwd: dirname(controlPath),
      env: smokeEnvironment(descriptor, dataDir),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-32_768); });
    const pending = new Map<string, {
      accept: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }>();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
    let protocolError: Error | undefined;
    lines.on('line', (line) => {
      if (line.length > 1_048_576) {
        protocolError = new Error('Control bridge emitted an oversized stdout frame');
        child.kill('SIGKILL');
        return;
      }
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.protocol !== 'clawx.kernel/v1' || typeof message.id !== 'string' || typeof message.ok !== 'boolean') {
          throw new Error('invalid control response envelope');
        }
        const request = pending.get(message.id);
        if (!request) throw new Error('unknown control response ID');
        clearTimeout(request.timeout);
        pending.delete(message.id);
        if (message.ok) request.accept(message.result);
        else request.reject(new Error(String((message.error as { message?: unknown } | undefined)?.message ?? 'Control request failed')));
      } catch (error) {
        protocolError = error instanceof Error ? error : new Error(String(error));
        child.kill('SIGKILL');
      }
    });
    const request = <T>(method: string, params: unknown): Promise<T> => {
      const id = randomUUID();
      return new Promise<T>((accept, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out; stderr=${stderr}`));
        }, descriptor.budgets.coldReadyMs);
        pending.set(id, { accept: value => accept(value as T), reject, timeout });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (!error) return;
          clearTimeout(timeout);
          pending.delete(id);
          reject(error);
        });
      });
    };
    try {
      const initialized = await request<{
        kernelId: string;
        artifactVersion: string;
        generation: number;
        capabilitiesDigest?: string;
      }>('initialize', {
        artifactVersion: descriptor.artifactVersion,
        capabilitiesDigest: descriptor.supplyChain.fileManifestSha256,
      });
      const readyMs = Math.ceil(performance.now() - startedAt);
      if (initialized.kernelId !== descriptor.kernelId
        || initialized.artifactVersion !== descriptor.artifactVersion
        || initialized.generation !== 1
        || initialized.capabilitiesDigest !== descriptor.supplyChain.fileManifestSha256) {
        throw new Error('Control bridge initialize identity mismatch');
      }
      const health = await request<{ status: string; pid: number; rssBytes: number }>('health', {});
      if (health.status !== 'ready' || !Number.isSafeInteger(health.pid) || health.pid !== child.pid
        || !Number.isSafeInteger(health.rssBytes) || health.rssBytes > descriptor.budgets.idleRssBytes
        || readyMs > descriptor.budgets.coldReadyMs) {
        throw new Error(`Control bridge health budget failed: ${JSON.stringify({ health, readyMs })}`);
      }
      const diagnostics = await request<{ nodeVersion?: string; moduleAbi?: number }>('diagnostics', {});
      if (diagnostics.nodeVersion && diagnostics.nodeVersion !== descriptor.node.version) {
        throw new Error('Bundled Node version differs from the signed descriptor');
      }
      if (diagnostics.moduleAbi && diagnostics.moduleAbi !== descriptor.node.moduleAbi) {
        throw new Error('Bundled Node module ABI differs from the signed descriptor');
      }
      await request('shutdown', {});
      await waitForExit(child, 5_000);
      return { readyMs, rssBytes: health.rssBytes, pid: health.pid };
    } catch (error) {
      child.kill('SIGKILL');
      await waitForExit(child, 2_000).catch(() => undefined);
      throw new KernelPackageError(
        'smoke-failed',
        `Runtime smoke test failed: ${(protocolError ?? error) instanceof Error ? (protocolError ?? error as Error).message : String(error)}`,
        protocolError ?? error,
      );
    } finally {
      for (const item of pending.values()) {
        clearTimeout(item.timeout);
        item.reject(new Error('Control bridge smoke test ended'));
      }
      pending.clear();
      lines.close();
      child.stdin.destroy();
      await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

function smokeEnvironment(descriptor: KernelArtifactDescriptorV1, dataDir: string): NodeJS.ProcessEnv {
  const inherited = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of inherited) if (process.env[key]) env[key] = process.env[key];
  return {
    ...env,
    CLAWX_MANAGED_RUNTIME: '1',
    CLAWX_CONVERSATION_STORE_PROTOCOL: 'clawx.conversation-store/v1',
    CLAWX_DISABLE_NATIVE_HISTORY: '1',
    CLAWX_DISABLE_NATIVE_SCHEDULER: '1',
    OPENCLAW_DISABLE_NATIVE_HISTORY: '1',
    DSH_DISABLE_NATIVE_SCHEDULER: '1',
    CLAWX_KERNEL_ID: descriptor.kernelId,
    CLAWX_KERNEL_ARTIFACT_VERSION: descriptor.artifactVersion,
    CLAWX_KERNEL_CAPABILITIES_DIGEST: descriptor.supplyChain.fileManifestSha256,
    CLAWX_KERNEL_GENERATION: '1',
    CLAWX_KERNEL_DATA_DIR: dataDir,
    CLAWX_KERNEL_CONFIG_DIR: join(dataDir, 'config'),
    CLAWX_KERNEL_CACHE_DIR: join(dataDir, 'cache'),
    NODE_NO_WARNINGS: '1',
  };
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error('Runtime process did not exit before timeout')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      accept();
    });
  });
}
