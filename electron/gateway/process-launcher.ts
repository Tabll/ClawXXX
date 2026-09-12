import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'fs';
import path from 'path';
import type { GatewayLaunchContext } from './config-sync';
import type { GatewayLifecycleState } from './process-policy';
import { logger } from '../utils/logger';
import { appendNodeRequireToNodeOptions } from '../utils/paths';
import { requireOpenClawRuntimeLocation } from '../kernels/openclaw/runtime-location';
import { buildKernelNodeEnvironment } from '../kernels/node-runtime';

const GATEWAY_FETCH_PRELOAD_SOURCE = `'use strict';
(function () {
  var _f = globalThis.fetch;
  if (typeof _f !== 'function') return;
  if (globalThis.__clawxFetchPatched) return;
  globalThis.__clawxFetchPatched = true;

  globalThis.fetch = function clawxFetch(input, init) {
    var url =
      typeof input === 'string' ? input
        : input && typeof input === 'object' && typeof input.url === 'string'
          ? input.url : '';

    if (url.indexOf('openrouter.ai') !== -1) {
      init = init ? Object.assign({}, init) : {};
      var prev = init.headers;
      var flat = {};
      if (prev && typeof prev.forEach === 'function') {
        prev.forEach(function (v, k) { flat[k] = v; });
      } else if (prev && typeof prev === 'object') {
        Object.assign(flat, prev);
      }
      delete flat['http-referer'];
      delete flat['HTTP-Referer'];
      delete flat['x-title'];
      delete flat['X-Title'];
      delete flat['x-openrouter-title'];
      delete flat['X-OpenRouter-Title'];
      flat['HTTP-Referer'] = 'https://claw-x.com';
      flat['X-OpenRouter-Title'] = 'ClawX';
      init.headers = flat;
    }
    return _f.call(globalThis, input, init);
  };

  if (process.platform === 'win32') {
    try {
      var cp = require('child_process');
      if (!cp.__clawxPatched) {
        cp.__clawxPatched = true;
        ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync'].forEach(function(method) {
          var original = cp[method];
          if (typeof original !== 'function') return;
          cp[method] = function() {
            var args = Array.prototype.slice.call(arguments);
            var optIdx = -1;
            for (var i = 1; i < args.length; i++) {
              var a = args[i];
              if (a && typeof a === 'object' && !Array.isArray(a)) {
                optIdx = i;
                break;
              }
            }
            if (optIdx >= 0) {
              args[optIdx].windowsHide = true;
            } else {
              var opts = { windowsHide: true };
              if (typeof args[args.length - 1] === 'function') {
                args.splice(args.length - 1, 0, opts);
              } else {
                args.push(opts);
              }
            }
            return original.apply(this, args);
          };
        });
      }
    } catch (e) {
      // ignore
    }
  }
})();
`;

export function buildGatewayRuntimeEnv(
  forkEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...forkEnv,
    // ClawX does not expose LAN discovery, so keep Bonjour disabled even if
    // the parent process inherited an explicit opt-in value.
    OPENCLAW_DISABLE_BONJOUR: '1',
    // OpenClaw's built-in trace contains stage names and timings only. Keep it
    // enabled so packaged startup incidents are diagnosable from normal logs.
    OPENCLAW_GATEWAY_STARTUP_TRACE: '1',
  };
}

function ensureGatewayFetchPreload(): string {
  const dest = path.join(app.getPath('userData'), 'gateway-fetch-preload.cjs');
  try {
    writeFileSync(dest, GATEWAY_FETCH_PRELOAD_SOURCE, 'utf-8');
  } catch {
    // best-effort
  }
  return dest;
}

export async function launchGatewayProcess(options: {
  port: number;
  launchContext: GatewayLaunchContext;
  sanitizeSpawnArgs: (args: string[]) => string[];
  getCurrentState: () => GatewayLifecycleState;
  getShouldReconnect: () => boolean;
  onStderrLine: (line: string) => void;
  onSpawn: (pid: number | undefined) => void;
  onExit: (child: ChildProcess, code: number | null) => void;
  onError: (error: Error, child: ChildProcess) => void;
}): Promise<{ child: ChildProcess; lastSpawnSummary: string }> {
  const {
    openclawDir,
    entryScript,
    gatewayArgs,
    forkEnv,
    mode,
    binPathExists,
    loadedProviderKeyCount,
    proxySummary,
    channelStartupSummary,
  } = options.launchContext;

  logger.info(
    `Starting Gateway process (mode=${mode}, port=${options.port}, entry="${entryScript}", args="${options.sanitizeSpawnArgs(gatewayArgs).join(' ')}", cwd="${openclawDir}", bundledBin=${binPathExists ? 'yes' : 'no'}, providerKeys=${loadedProviderKeyCount}, channels=${channelStartupSummary}, proxy=${proxySummary})`,
  );
  const lastSpawnSummary = `mode=${mode}, entry="${entryScript}", args="${options.sanitizeSpawnArgs(gatewayArgs).join(' ')}", cwd="${openclawDir}"`;

  const { nodeExecutable } = requireOpenClawRuntimeLocation();
  const runtimeEnv = buildGatewayRuntimeEnv(buildKernelNodeEnvironment(nodeExecutable, forkEnv));

  // Disable OpenClaw's mDNS/Bonjour gateway advertiser unconditionally.
  //
  // The OpenClaw gateway advertises `_openclaw-gw._tcp.local` on every
  // active network interface using a hardcoded `openclaw.local` hostname,
  // which causes:
  //   - cross-machine name collisions when multiple OpenClaw/ClawX peers
  //     share a LAN (each falls back to "<name> (OpenClaw) (2)")
  //   - self-collisions on multi-homed hosts (Wi-Fi + Tailscale + utun ...)
  //   - "ghost" record collisions after an unclean ClawX exit, because
  //     SIGKILL prevents ciao from emitting the mDNS goodbye record.
  //
  // ClawX has no UI for LAN gateway discovery today, so the advertiser is
  // pure log noise.  `OPENCLAW_DISABLE_BONJOUR=1` short-circuits
  // `startGatewayBonjourAdvertiser()` (openclaw `src/infra/bonjour.ts`,
  // `isDisabledByEnv()`).  Set after the `forkEnv` spread so any
  // pre-existing value inherited from the user shell cannot re-enable it.
  // buildGatewayRuntimeEnv() applies both this policy and startup tracing
  // before any development-only environment augmentation below.

  // Preserve the existing development-only preload policy. The child is now
  // standalone Node, never an Electron Helper posing as a Node executable.
  if (!app.isPackaged) {
    try {
      const preloadPath = ensureGatewayFetchPreload();
      if (existsSync(preloadPath)) {
        runtimeEnv.NODE_OPTIONS = appendNodeRequireToNodeOptions(
          runtimeEnv.NODE_OPTIONS,
          preloadPath,
        );
      }
    } catch (err) {
      logger.warn('Failed to set up OpenRouter headers preload:', err);
    }
  }

  return await new Promise<{ child: ChildProcess; lastSpawnSummary: string }>((resolve, reject) => {
    const child = spawn(nodeExecutable, [entryScript, ...gatewayArgs], {
      cwd: openclawDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: runtimeEnv as NodeJS.ProcessEnv,
      windowsHide: true,
      shell: false,
    });

    let settled = false;
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolve({ child, lastSpawnSummary });
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.on('error', (error: unknown) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      logger.error('Gateway process spawn error:', error);
      options.onError(normalizedError, child);
      rejectOnce(normalizedError);
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // Only check shouldReconnect — not current state.  On Windows the WS
      // close handler fires before the process exit handler and sets state to
      // 'stopped', which would make an unexpected crash look like a planned
      // shutdown in logs.  shouldReconnect is the reliable indicator: stop()
      // sets it to false (expected), crashes leave it true (unexpected).
      const expectedExit = !options.getShouldReconnect();
      const level = expectedExit ? logger.info : logger.warn;
      level(`Gateway process exited (code=${code}, signal=${signal ?? 'none'}, expected=${expectedExit ? 'yes' : 'no'})`);
      options.onExit(child, code);
    });

    child.stderr?.on('data', (data) => {
      const raw = data.toString();
      for (const line of raw.split(/\r?\n/)) {
        options.onStderrLine(line);
      }
    });

    child.on('spawn', () => {
      logger.info(`Gateway process started (pid=${child.pid}, node="${nodeExecutable}")`);
      options.onSpawn(child.pid);
      resolveOnce();
    });
  });
}
