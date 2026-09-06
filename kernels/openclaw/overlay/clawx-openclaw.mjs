#!/usr/bin/env node
// ClawX managed OpenClaw entrypoint. The original openclaw.mjs remains an
// immutable upstream file beside this wrapper for provenance and patch review.
import { fileURLToPath } from 'node:url';
if (process.env.CLAWX_MANAGED_RUNTIME !== '1') {
  throw new Error('ClawX OpenClaw runtime must be launched in managed mode');
}

Object.assign(process.env, {
  CLAWX_OPENCLAW_PACKAGE_DIR: fileURLToPath(new URL('.', import.meta.url)),
  OPENCLAW_NO_RESPAWN: '1',
  OPENCLAW_EMBEDDED_IN: 'ClawX',
  OPENCLAW_HISTORY_MODE: 'clawx-data-service',
  OPENCLAW_DISABLE_NATIVE_HISTORY: '1',
  OPENCLAW_DISABLE_CRON_HISTORY: '1',
  OPENCLAW_SKIP_CRON: '1',
  CLAWX_DISABLE_NATIVE_SCHEDULER: '1',
  OPENCLAW_DISABLE_TRANSCRIPT_USAGE_SCAN: '1',
  OPENCLAW_TRAJECTORY_ENABLED: '0',
});

if (!process.env.OPENCLAW_STATE_DIR || !process.env.OPENCLAW_CONFIG_PATH) {
  throw new Error('Managed OpenClaw state/config roots are required');
}

await import('./openclaw.mjs');
