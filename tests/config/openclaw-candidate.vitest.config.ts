import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config';

// Explicit opt-in only: candidate checks must never silently use the installed
// July SDK or change the package selected by the application.
const candidate = process.env.CLAWX_OPENCLAW_CANDIDATE_DIR?.trim();
if (!candidate) throw new Error('CLAWX_OPENCLAW_CANDIDATE_DIR is required');
const expectedVersion = process.env.CLAWX_OPENCLAW_CANDIDATE_VERSION?.trim();
if (!expectedVersion) throw new Error('CLAWX_OPENCLAW_CANDIDATE_VERSION is required');
const packageRoot = resolve(candidate);
const metadata = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
if (metadata.name !== 'openclaw' || metadata.version !== expectedVersion) {
  throw new Error('OpenClaw candidate package identity is invalid');
}

export default mergeConfig(base, {
  resolve: {
    alias: Object.fromEntries(['agent-core', 'agent-sessions', 'llm'].map(name => [
      `openclaw/plugin-sdk/${name}`,
      resolve(packageRoot, `dist/plugin-sdk/${name}.js`),
    ])),
  },
});
