#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { zstdDecompressSync } from 'node:zlib';
import tar from 'tar';
import { readJson, sha256File } from './lib/canonical.mjs';
import { scanRuntimeDataPaths } from './lib/storage-contract.mjs';
import { verifyPlatformRuntime } from './verify-platform-runtime.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const artifactDir = args.get('--artifact-dir');
const discovered = artifactDir ? discoverArtifact(resolve(artifactDir)) : undefined;
const archivePath = resolve(args.get('--archive') ?? discovered?.archive ?? required('--archive'));
const descriptor = readJson(resolve(args.get('--descriptor') ?? discovered?.descriptor ?? required('--descriptor')));
if (descriptor.archive.sha256 !== sha256File(archivePath)) throw new Error('Artifact archive digest mismatch');
if (descriptor.platform !== process.platform || descriptor.arch !== process.arch) {
  throw new Error(`Artifact target ${descriptor.platform}-${descriptor.arch} does not match smoke host ${process.platform}-${process.arch}`);
}
const root = mkdtempSync(join(tmpdir(), 'clawx-runtime-smoke-'));
try {
  const managedDataRoot = join(root, 'managed-data');
  mkdirSync(managedDataRoot, { recursive: true, mode: 0o700 });
  const tarPath = join(root, 'artifact.tar');
  writeFileSync(tarPath, zstdDecompressSync(readFileSync(archivePath)), { mode: 0o600 });
  await validateTar(tarPath);
  const extracted = join(root, 'extracted');
  mkdirSync(extracted, { recursive: true, mode: 0o700 });
  await tar.x({ file: tarPath, cwd: extracted, strict: true, preservePaths: false });
  verifyFileManifest(extracted);
  const platformSecurityPath = join(extracted, 'metadata', 'platform-security.json');
  if (descriptor.supplyChain.platformSecurityReportSha256) {
    if (sha256File(platformSecurityPath) !== descriptor.supplyChain.platformSecurityReportSha256) {
      throw new Error('Platform security report digest mismatch');
    }
    const platformSecurity = readJson(platformSecurityPath);
    if (platformSecurity.ok !== true || platformSecurity.platform !== descriptor.platform || platformSecurity.arch !== descriptor.arch) {
      throw new Error('Platform security report identity mismatch');
    }
  }
  const nodePath = join(extracted, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'));
  const entrypoint = inside(extracted, descriptor.entrypoints.control);
  if (!existsSync(nodePath) || !existsSync(entrypoint)) throw new Error('Runtime Node or control entrypoint is missing');
  const platformVerification = verifyPlatformRuntime({
    kernelRoot: join(extracted, 'runtime', 'kernel'),
    nodeRoot: join(extracted, 'runtime', 'node'),
    platform: descriptor.platform,
    assessNotarization: true,
  });
  const dataDir = join(managedDataRoot, 'state');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const startedAt = performance.now();
  const child = spawn(nodePath, [entrypoint], {
    cwd: join(extracted, 'runtime', 'kernel'),
    env: {
      ...process.env,
      CLAWX_KERNEL_ARTIFACT_VERSION: descriptor.artifactVersion,
      CLAWX_KERNEL_CAPABILITIES_DIGEST: descriptor.supplyChain.fileManifestSha256,
      CLAWX_KERNEL_GENERATION: '1',
      CLAWX_KERNEL_DATA_DIR: dataDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
  const responses = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  lines.on('line', (line) => {
    try {
      const response = JSON.parse(line);
      responses.get(response.id)?.(response);
    } catch {
      child.kill();
    }
  });
  const request = (id, method, params = {}) => new Promise((accept, reject) => {
    const timeout = setTimeout(() => {
      responses.delete(id);
      reject(new Error(`${method} timed out; stderr=${stderr}`));
    }, descriptor.budgets.coldReadyMs);
    responses.set(id, (response) => {
      clearTimeout(timeout);
      responses.delete(id);
      if (!response.ok) reject(new Error(`${method} failed: ${JSON.stringify(response.error)}`));
      else accept(response.result);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const initialized = await request('initialize', 'initialize', {
    artifactVersion: descriptor.artifactVersion,
    capabilitiesDigest: descriptor.supplyChain.fileManifestSha256,
  });
  const readyMs = Math.ceil(performance.now() - startedAt);
  if (initialized.kernelId !== descriptor.kernelId
    || initialized.artifactVersion !== descriptor.artifactVersion
    || initialized.generation !== 1
    || initialized.capabilitiesDigest !== descriptor.supplyChain.fileManifestSha256) {
    throw new Error('Runtime initialize identity mismatch');
  }
  const health = await request('health', 'health');
  if (health.status !== 'ready' || health.rssBytes > descriptor.budgets.idleRssBytes) {
    throw new Error(`Runtime health/RSS budget failed: ${JSON.stringify(health)}`);
  }
  if (readyMs > descriptor.budgets.coldReadyMs) throw new Error(`Runtime cold-ready budget failed: ${readyMs}ms`);
  await request('shutdown', 'shutdown');
  await waitForExit(child, 5_000);
  const openClawSelfTest = descriptor.kernelId === 'openclaw'
    ? await smokeOpenClawManagedEntrypoint({ nodePath, extracted, descriptor, managedDataRoot })
    : undefined;
  const deepSeekHarnessSelfTest = descriptor.kernelId === 'deepseek-harness'
    ? await smokeDeepSeekHarnessHost({ nodePath, extracted, descriptor, managedDataRoot })
    : undefined;
  const runtimeDataScan = scanRuntimeDataPaths(managedDataRoot);
  if (!runtimeDataScan.ok) {
    throw new Error(`Managed runtime wrote forbidden durable history:\n${runtimeDataScan.violations.join('\n')}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    kernelId: descriptor.kernelId,
    artifactVersion: descriptor.artifactVersion,
    readyMs,
    rssBytes: health.rssBytes,
    platformVerification,
    runtimeDataScan: {
      ok: true,
      scannedPathCount: runtimeDataScan.scannedPaths.length,
      nativeDurableHistory: false,
    },
    ...(openClawSelfTest === undefined ? {} : { openClawSelfTest }),
    ...(deepSeekHarnessSelfTest === undefined ? {} : { deepSeekHarnessSelfTest }),
  })}\n`);
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

async function smokeOpenClawManagedEntrypoint({ nodePath, extracted, descriptor, managedDataRoot }) {
  const chatPath = inside(extracted, descriptor.entrypoints.chat);
  if (!existsSync(chatPath)) throw new Error('OpenClaw managed chat entrypoint is missing');
  const stateDir = join(managedDataRoot, 'config', 'openclaw');
  const cacheDir = join(managedDataRoot, 'cache', 'openclaw');
  const tempDir = join(cacheDir, 'tmp');
  for (const directory of [stateDir, cacheDir, tempDir]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const child = spawn(nodePath, [chatPath, '--version'], {
    cwd: join(extracted, 'runtime', 'kernel'),
    env: {
      ...process.env,
      CLAWX_MANAGED_RUNTIME: '1',
      CLAWX_CONVERSATION_STORE_PROTOCOL: 'clawx.conversation-store/v1',
      CLAWX_DISABLE_NATIVE_HISTORY: '1',
      CLAWX_DISABLE_NATIVE_SCHEDULER: '1',
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: join(stateDir, 'openclaw.json'),
      OPENCLAW_CACHE_DIR: cacheDir,
      OPENCLAW_HISTORY_MODE: 'clawx-data-service',
      OPENCLAW_DISABLE_NATIVE_HISTORY: '1',
      OPENCLAW_DISABLE_CRON_HISTORY: '1',
      OPENCLAW_SKIP_CRON: '1',
      OPENCLAW_DISABLE_TRANSCRIPT_USAGE_SCAN: '1',
      OPENCLAW_TRAJECTORY_ENABLED: '0',
      OPENCLAW_NO_RESPAWN: '1',
      OPENCLAW_EMBEDDED_IN: 'ClawX',
      TMPDIR: tempDir,
      TMP: tempDir,
      TEMP: tempDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-16_384); });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
  await waitForExit(child, descriptor.budgets.coldReadyMs);
  if (child.exitCode !== 0) {
    throw new Error(`OpenClaw managed entrypoint failed --version (${child.exitCode}); stderr=${stderr}`);
  }
  const expectedVersion = String(descriptor.upstreamVersion ?? descriptor.artifactVersion).split('+')[0];
  const versionOutput = `${stdout}\n${stderr}`.trim();
  if (!versionOutput.includes(expectedVersion)) {
    throw new Error(`OpenClaw managed entrypoint version mismatch: expected ${expectedVersion}, output=${versionOutput}`);
  }
  return { managed: true, version: expectedVersion };
}

async function smokeDeepSeekHarnessHost({ nodePath, extracted, descriptor, managedDataRoot }) {
  const hostPath = inside(extracted, descriptor.entrypoints.host);
  if (!existsSync(hostPath)) throw new Error('DeepSeek Harness runtime host entrypoint is missing');
  const dataDir = join(managedDataRoot, 'state', 'deepseek-harness');
  const configDir = join(managedDataRoot, 'config', 'deepseek-harness');
  const cacheDir = join(managedDataRoot, 'cache', 'deepseek-harness');
  for (const directory of [dataDir, configDir, cacheDir]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const child = spawn(nodePath, [hostPath], {
    cwd: join(extracted, 'runtime', 'kernel'),
    env: {
      ...process.env,
      CLAWX_KERNEL_ID: descriptor.kernelId,
      CLAWX_KERNEL_ARTIFACT_VERSION: descriptor.artifactVersion,
      CLAWX_KERNEL_CAPABILITIES_DIGEST: descriptor.supplyChain.fileManifestSha256,
      CLAWX_KERNEL_GENERATION: '1',
      CLAWX_KERNEL_DATA_DIR: dataDir,
      CLAWX_KERNEL_CONFIG_DIR: configDir,
      CLAWX_KERNEL_CACHE_DIR: cacheDir,
      CLAWX_KERNEL_SELF_TEST: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  let readyAccept;
  let readyReject;
  const ready = new Promise((accept, reject) => {
    readyAccept = accept;
    readyReject = reject;
  });
  const responses = new Map();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_768); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      readyReject(new Error(`DeepSeek Harness host emitted non-JSON stdout: ${line}`));
      child.kill();
      return;
    }
    if (message.type === 'ready') readyAccept(message);
    else if (message.type === 'response') responses.get(message.requestId)?.(message);
    else {
      readyReject(new Error(`DeepSeek Harness host emitted an unexpected stdout envelope: ${line}`));
      child.kill();
    }
  });
  child.once('exit', (code) => {
    if (code !== 0) readyReject(new Error(`DeepSeek Harness host exited before ready (${code}); stderr=${stderr}`));
  });
  const request = (requestId, method, params = {}, identity) => new Promise((accept, reject) => {
    const timeout = setTimeout(() => {
      responses.delete(requestId);
      reject(new Error(`${method} timed out; stderr=${stderr}`));
    }, Math.max(60_000, descriptor.budgets.coldReadyMs));
    responses.set(requestId, (response) => {
      clearTimeout(timeout);
      responses.delete(requestId);
      if (!response.ok) reject(new Error(`${method} failed: ${JSON.stringify(response.error)}; stderr=${stderr}`));
      else accept(response.result);
    });
    child.stdin.write(`${JSON.stringify({
      protocol: 'clawx.kernel-stdio/v1',
      type: 'request',
      requestId,
      kernelId: descriptor.kernelId,
      generation: 1,
      method,
      ...(identity === undefined ? {} : { identity }),
      params,
    })}\n`);
  });
  try {
    const readyMessage = await withTimeout(
      ready,
      descriptor.budgets.coldReadyMs,
      () => `DeepSeek Harness host ready timed out; stderr=${stderr}`,
    );
    if (readyMessage.kernelId !== descriptor.kernelId
      || readyMessage.generation !== 1
      || readyMessage.version !== descriptor.artifactVersion
      || readyMessage.rssBytes > descriptor.budgets.idleRssBytes) {
      throw new Error(`DeepSeek Harness host ready identity/RSS mismatch: ${JSON.stringify(readyMessage)}`);
    }
    const initialized = await request('host-initialize', 'control.initialize', {
      artifactVersion: descriptor.artifactVersion,
      generation: 1,
      capabilitiesDigest: descriptor.supplyChain.fileManifestSha256,
    });
    if (initialized.kernelId !== descriptor.kernelId
      || initialized.artifactVersion !== descriptor.artifactVersion
      || initialized.generation !== 1
      || initialized.capabilitiesDigest !== descriptor.supplyChain.fileManifestSha256) {
      throw new Error(`DeepSeek Harness host initialize identity mismatch: ${JSON.stringify(initialized)}`);
    }
    const health = await request('host-health', 'runtime.health');
    if (health.status !== 'ready' || health.rssBytes > descriptor.budgets.idleRssBytes) {
      throw new Error(`DeepSeek Harness host health/RSS budget failed: ${JSON.stringify(health)}`);
    }
    const identity = { conversationId: 'artifact-smoke', turnId: 'turn-1', runId: 'run-1' };
    const session = await request('host-session-new', 'session.new', {}, identity);
    if (session.nativeSessionId !== null
      || session.hydration !== 'canonical-on-prompt'
      || session.durableState !== 'clawx-data-service') {
      throw new Error(`DeepSeek Harness session.new violated canonical storage authority: ${JSON.stringify(session)}`);
    }
    const selfTest = await request('host-self-test', 'runtime.selfTest');
    if (selfTest?.sandbox?.workspaceWrite !== true
      || selfTest?.sandbox?.readOnlyDenied !== true
      || selfTest?.sandbox?.windowsAmbientTempDenied !== (process.platform === 'win32' ? true : 'not-applicable')
      || selfTest?.tools?.writeReadRoundTrip !== true
      || selfTest?.permissions?.approvalPolicy !== 'ask'
      || selfTest?.permissions?.orphanQuestionRejected !== true) {
      throw new Error(`DeepSeek Harness sandbox/tool/permission self-test failed: ${JSON.stringify(selfTest)}`);
    }
    await request('host-shutdown', 'runtime.shutdown');
    await waitForExit(child, 5_000);
    if (child.exitCode !== 0) throw new Error(`DeepSeek Harness host shutdown exit code was ${child.exitCode}; stderr=${stderr}`);
    return selfTest;
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGKILL');
    await waitForExit(child, 5_000).catch(() => undefined);
    throw error;
  }
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error(message())), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timeout); accept(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
}

async function validateTar(path) {
  const violations = [];
  await tar.t({
    file: path,
    strict: true,
    onentry(entry) {
      if (entry.path.startsWith('/') || entry.path.includes('\\') || entry.path.split('/').some((part) => part === '..')
        || !['File', 'Directory'].includes(entry.type)) violations.push(`${entry.type}:${entry.path}`);
    },
  });
  if (violations.length > 0) throw new Error(`Unsafe artifact archive:\n${violations.join('\n')}`);
}

function verifyFileManifest(root) {
  const manifest = readJson(join(root, 'metadata', 'files.json'));
  const runtimeRoot = join(root, 'runtime');
  const actual = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) actual.push(path);
      else throw new Error(`Runtime contains a non-regular entry: ${path}`);
    }
  };
  visit(runtimeRoot);
  if (actual.length !== manifest.fileCount) throw new Error('Runtime file count differs from manifest');
  const byPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const path of actual) {
    const name = relative(runtimeRoot, path).split(sep).join('/');
    const expected = byPath.get(name);
    if (!expected || expected.size !== statSync(path).size || expected.sha256 !== sha256File(path)) {
      throw new Error(`Runtime file integrity mismatch: ${name}`);
    }
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((accept, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Runtime did not exit after shutdown'));
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      accept();
    });
  });
}

function inside(root, path) {
  const base = resolve(root);
  const target = resolve(base, path);
  if (!target.startsWith(`${base}${sep}`) || lstatSync(target).isSymbolicLink()) throw new Error(`Unsafe runtime path: ${path}`);
  return target;
}

function required(key) {
  const value = args.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function discoverArtifact(directory) {
  const files = readdirSync(directory).map((name) => join(directory, name));
  const descriptors = files.filter((path) => path.endsWith('.descriptor.json'));
  const archives = files.filter((path) => path.endsWith('.tar.zst'));
  if (descriptors.length !== 1 || archives.length !== 1) throw new Error('Artifact directory must contain exactly one descriptor and archive');
  return { descriptor: descriptors[0], archive: archives[0] };
}
