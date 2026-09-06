#!/usr/bin/env node
import { createInterface } from 'node:readline';

const artifactVersion = process.env.CLAWX_KERNEL_ARTIFACT_VERSION ?? '2026.9.2+clawx.8';
const generation = Number.parseInt(process.env.CLAWX_KERNEL_GENERATION ?? '0', 10);
const startedAt = Date.now();
let initialized = false;

const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
input.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
    if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') throw new Error('invalid request');
  } catch (error) {
    process.stderr.write(`[clawx-openclaw-control] rejected malformed request: ${String(error)}\n`);
    return;
  }
  try {
    const result = dispatch(request.method, request.params);
    process.stdout.write(`${JSON.stringify({ protocol: 'clawx.kernel/v1', id: request.id, ok: true, result })}\n`);
    if (request.method === 'shutdown') queueMicrotask(() => process.exit(0));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      protocol: 'clawx.kernel/v1',
      id: request.id,
      ok: false,
      error: { code: error.code ?? 'internal', message: String(error.message ?? error) },
    })}\n`);
  }
});

function dispatch(method, params) {
  if (method === 'initialize') {
    const expected = params?.artifactVersion;
    if (expected !== artifactVersion) throw protocolError('artifact-mismatch', `Expected ${expected}, running ${artifactVersion}`);
    initialized = true;
    return {
      kernelId: 'openclaw',
      artifactVersion,
      generation,
      protocols: { control: 1, conversationStore: 1, chat: 1 },
      capabilitiesDigest: params?.capabilitiesDigest,
    };
  }
  if (!initialized) throw protocolError('not-initialized', 'initialize must be the first successful request');
  if (method === 'health') {
    return { status: 'ready', pid: process.pid, generation, uptimeMs: Date.now() - startedAt, rssBytes: process.memoryUsage().rss };
  }
  if (method === 'diagnostics') {
    return {
      kernelId: 'openclaw',
      artifactVersion,
      generation,
      nodeVersion: process.versions.node,
      moduleAbi: Number(process.versions.modules),
      pid: process.pid,
    };
  }
  if (method === 'shutdown') return { accepted: true };
  throw protocolError('unsupported', `Unsupported control method: ${method}`);
}

function protocolError(code, message) {
  return Object.assign(new Error(message), { code });
}
