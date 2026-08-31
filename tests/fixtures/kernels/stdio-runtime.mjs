import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const bootStartedAt = performance.now();
const protocol = 'clawx.kernel-stdio/v1';
const kernelId = process.env.CLAWX_KERNEL_ID;
const generation = Number(process.env.CLAWX_KERNEL_GENERATION);
if (!kernelId || !Number.isSafeInteger(generation) || generation < 1) process.exit(64);

const send = message => process.stdout.write(`${JSON.stringify({ protocol, kernelId, generation, ...message })}\n`);
const runs = new Map();
const delayMultiplier = Math.max(1, Number(process.env.CLAWX_FIXTURE_DELAY_MULTIPLIER) || 1);
const grandchild = process.env.CLAWX_FIXTURE_SPAWN_GRANDCHILD === '1'
  ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  })
  : undefined;

send({
  type: 'ready',
  pid: process.pid,
  version: process.env.CLAWX_KERNEL_ARTIFACT_VERSION
    || (kernelId === 'openclaw' ? '2026.7.1-2.clawx.1' : '0.1.2-alpha.2.clawx.9'),
  startupDurationMs: performance.now() - bootStartedAt,
  rssBytes: process.memoryUsage().rss,
  capabilities: {
    chat: true, cancel: true, permissions: true, resume: true, configuration: true,
    agents: true, providers: true, skills: true, channels: true, cron: true, usage: true,
    checkpointCodecs: [`clawx.${kernelId}.fixture/v1`],
  },
});

if (grandchild?.pid) process.stderr.write(`fixture-grandchild:${grandchild.pid}\n`);
const crashAfterReadyMs = Number(process.env.CLAWX_FIXTURE_CRASH_AFTER_READY_MS);
if (Number.isFinite(crashAfterReadyMs) && crashAfterReadyMs >= 0) {
  setTimeout(() => process.exit(86), crashAfterReadyMs);
}

const respond = (request, result) => send({ type: 'response', requestId: request.requestId, ok: true, result });
const emit = (identity, eventSeq, kind, payload) => send({ type: 'event', identity, eventSeq, event: { kind, payload } });

async function prompt(request) {
  const { identity } = request;
  if (!identity) throw new Error('prompt identity is required');
  const state = { cancelled: false, timers: [] };
  runs.set(identity.runId, state);
  respond(request, { accepted: true });
  const delay = (kernelId === 'openclaw' ? 20 : 10) * delayMultiplier;
  state.timers.push(setTimeout(() => {
    if (!state.cancelled) emit(identity, 1, 'assistant.delta', { text: `${kernelId}:first` });
  }, delay));
  state.timers.push(setTimeout(() => {
    if (!state.cancelled) emit(identity, 2, 'assistant.final', { text: `${kernelId}:done` });
  }, delay * 2));
  state.timers.push(setTimeout(() => {
    if (!state.cancelled) emit(identity, 3, 'run.terminal', { outcome: 'completed' });
    runs.delete(identity.runId);
  }, delay * 3));
}

function cancel(request) {
  const runId = request.identity?.runId;
  const state = runId ? runs.get(runId) : undefined;
  if (state && request.identity) {
    state.cancelled = true;
    for (const timer of state.timers) clearTimeout(timer);
    emit(request.identity, 1, 'cancel.acknowledged', {});
    emit(request.identity, 2, 'run.terminal', { outcome: 'cancelled' });
    runs.delete(runId);
  }
  respond(request, { cancelled: Boolean(state) });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.protocol !== protocol || request.type !== 'request') return;
  if (request.kernelId !== kernelId || request.generation !== generation) return;
  if (request.method === 'session.prompt') void prompt(request);
  else if (request.method === 'session.cancel') cancel(request);
  else if (request.method === 'runtime.health') respond(request, { ready: true, pid: process.pid });
  else if (request.method === 'runtime.diagnostics') respond(request, {
    ready: true,
    pid: process.pid,
    generation,
    grandchildPid: grandchild?.pid,
  });
  else if (request.method === 'fixture.grandchild') respond(request, { pid: grandchild?.pid });
  else if (request.method === 'fixture.stderr') {
    process.stderr.write(`${String(request.params?.message ?? 'fixture diagnostic')}\n`);
    respond(request, { written: true });
  }
  else if (request.method === 'fixture.crash') {
    respond(request, { crashing: true });
    setImmediate(() => process.exit(86));
  }
  else if (request.method === 'session.configure' || request.method === 'session.permission.resolve') {
    respond(request, { accepted: true });
  }
  else if (request.method === 'runtime.shutdown') {
    respond(request, { stopping: true });
    if (process.env.CLAWX_FIXTURE_IGNORE_SHUTDOWN !== '1') setImmediate(() => process.exit(0));
  } else send({
    type: 'response', requestId: request.requestId, ok: false,
    error: { code: 'METHOD_NOT_FOUND', message: `Unknown method ${request.method}` },
  });
});
