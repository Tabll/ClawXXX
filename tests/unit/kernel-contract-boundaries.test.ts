// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const canonicalFiles = [
  'shared/conversations/contracts.ts',
  'shared/conversations/store-protocol.ts',
  'shared/kernels/contracts.ts',
  'shared/kernels/runtime-protocol.ts',
  'shared/domains/agents.ts',
  'shared/domains/providers.ts',
  'shared/domains/skills.ts',
  'shared/domains/channels.ts',
  'shared/domains/cron.ts',
  'shared/domains/usage.ts',
];

describe('canonical multi-kernel contract boundary', () => {
  it('does not import OpenClaw, DSH, ACP, Gateway, Electron, or runtime-native protocol types', () => {
    for (const file of canonicalFiles) {
      const source = readFileSync(resolve(file), 'utf8');
      const imports = source.split('\n').filter(line => /^import\s/.test(line));
      expect(imports.join('\n'), file).not.toMatch(
        /openclaw|deepseek-ai|agentclientprotocol|electron\/gateway|from ['"]electron['"]/i,
      );
    }
  });
});
