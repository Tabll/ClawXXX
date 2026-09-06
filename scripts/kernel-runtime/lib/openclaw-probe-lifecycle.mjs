import { setTimeout as delay } from 'node:timers/promises';

// Only the real full-graph probe: control-bridge and application budgets stay
// unchanged. Windows cold CLI + seven Channel imports can exceed 90 seconds.
export function openClawProbeBudgets(platform = process.platform) {
  return Object.freeze({ gatewayReadyMs: platform === 'win32' ? 180_000 : 90_000, totalMs: platform === 'win32' ? 600_000 : 300_000 });
}

export async function waitForGatewayReady(child, url, {
  timeoutMs = openClawProbeBudgets().gatewayReadyMs,
  fetchHealth = fetch, now = () => performance.now(), sleep = delay,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid Gateway startup budget');
  const started = now();
  let lastHealth = 'not reachable';
  let spawnError;
  const onError = error => { spawnError = error; };
  child.on('error', onError);
  const assertAlive = () => {
    if (spawnError) throw new Error(`Gateway spawn failed: ${spawnError.message}`, { cause: spawnError });
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Gateway exited during startup (code=${child.exitCode}, signal=${child.signalCode})`);
  };
  try {
    while (true) {
      assertAlive();
      const remaining = timeoutMs - (now() - started);
      if (remaining <= 0) throw new Error(`Gateway startup timed out after ${timeoutMs}ms; last health=${lastHealth}`);
      let healthy = false;
      try {
        const response = await fetchHealth(url, { signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(500, remaining)))) });
        lastHealth = `HTTP ${response.status}`;
        await response.body?.cancel();
        healthy = response.ok;
      } catch (error) { lastHealth = error.code ?? error.name ?? 'request failed'; }
      assertAlive();
      if (healthy && now() - started < timeoutMs) return { readyMs: Math.ceil(now() - started), budgetMs: timeoutMs };
      await sleep(Math.max(0, Math.min(200, timeoutMs - (now() - started))));
    }
  } finally { child.off('error', onError); }
}
