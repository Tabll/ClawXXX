// @vitest-environment node

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import { createFakeHost, createFakeStore } from './driver-contract-kit';
import { FakeKernelDriver } from './fakes/fake-kernel-driver';

describe('new-storage cutover contract', () => {
  it.each(['openclaw', 'deepseek-harness'] as const)(
    'does not import, delete, or fall back to %s native conversation/Cron history',
    async kernelId => {
      const nativeRoot = mkdtempSync(join(tmpdir(), `clawx-${kernelId}-legacy-`));
      const sessionPath = join(nativeRoot, 'sessions', 'legacy.jsonl');
      const cronPath = join(nativeRoot, 'cron', 'jobs.json');
      mkdirSync(join(nativeRoot, 'sessions'), { recursive: true });
      mkdirSync(join(nativeRoot, 'cron'), { recursive: true });
      writeFileSync(sessionPath, '{"secret":"legacy-session"}\n');
      writeFileSync(cronPath, '{"jobs":[{"id":"legacy-cron"}]}');

      const store = createFakeStore();
      const host = createFakeHost(store);
      const driver = new FakeKernelDriver(kernelId);
      await driver.initialize(host);
      await driver.start();
      await driver.execute({
        conversationId: asConversationId('canonical-conversation'),
        turnId: asTurnId('canonical-turn'),
        runId: asRunId('canonical-run'),
        kernelId,
        generation: 1,
        context: [],
        agentId: 'canonical-agent',
        workspaceUri: 'file:///workspace',
      });

      expect(store.nativeHistoryFallback).toBe(false);
      expect(JSON.stringify(store.writes)).not.toContain('legacy-session');
      expect(JSON.stringify(store.writes)).not.toContain('legacy-cron');
      expect(existsSync(sessionPath)).toBe(true);
      expect(existsSync(cronPath)).toBe(true);
      expect(readFileSync(sessionPath, 'utf8')).toContain('legacy-session');
      expect(readFileSync(cronPath, 'utf8')).toContain('legacy-cron');
      await driver.stop();
    },
  );
});
