// @vitest-environment node

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KernelSupervisorRegistry } from '@electron/kernels/supervisor-registry';
import type { KernelStdioEvent } from '@shared/kernels/runtime-protocol';

const fixture = fileURLToPath(new URL('../../fixtures/kernels/stdio-runtime.mjs', import.meta.url));

function identity(kernelId: 'openclaw' | 'deepseek-harness') {
  return {
    conversationId: `conversation-${kernelId}`,
    turnId: `turn-${kernelId}`,
    runId: `run-${kernelId}`,
  };
}

function terminal(events: KernelStdioEvent[], runId: string): Promise<KernelStdioEvent> {
  const existing = events.find(event => event.identity.runId === runId && event.event.kind === 'run.terminal');
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`missing terminal event for ${runId}`)), 3_000);
    const poll = setInterval(() => {
      const event = events.find(item => item.identity.runId === runId && item.event.kind === 'run.terminal');
      if (!event) return;
      clearTimeout(timeout);
      clearInterval(poll);
      resolve(event);
    }, 5);
  });
}

describe('two-kernel process/stdio spike', () => {
  it('runs simultaneous prompts without crossing request, event, process, or generation identity', async () => {
    const registry = new KernelSupervisorRegistry(() => ({
      command: process.execPath,
      args: [fixture],
      startupTimeoutMs: 3_000,
      shutdownTimeoutMs: 1_000,
    }));
    const events: KernelStdioEvent[] = [];
    registry.on('event', event => events.push(event as KernelStdioEvent));
    try {
      const [openclaw, dsh] = await Promise.all([
        registry.start('openclaw'),
        registry.start('deepseek-harness'),
      ]);
      expect(openclaw.state).toBe('ready');
      expect(dsh.state).toBe('ready');
      expect(openclaw.pid).not.toBe(dsh.pid);
      expect(openclaw.startupDurationMs).toBeLessThan(1_000);
      expect(dsh.startupDurationMs).toBeLessThan(1_000);
      expect(openclaw.rssBytes).toBeGreaterThan(0);
      expect(dsh.rssBytes).toBeGreaterThan(0);

      const openclawIdentity = identity('openclaw');
      const dshIdentity = identity('deepseek-harness');
      await Promise.all([
        registry.request('openclaw', 'session.prompt', { text: 'A' }, openclawIdentity),
        registry.request('deepseek-harness', 'session.prompt', { text: 'B' }, dshIdentity),
      ]);
      await Promise.all([
        terminal(events, openclawIdentity.runId),
        terminal(events, dshIdentity.runId),
      ]);

      expect(events.filter(event => event.kernelId === 'openclaw')).toHaveLength(3);
      expect(events.filter(event => event.kernelId === 'deepseek-harness')).toHaveLength(3);
      for (const event of events) {
        expect(event.generation).toBe(1);
        expect(event.identity.conversationId).toBe(`conversation-${event.kernelId}`);
        expect(event.identity.runId).toBe(`run-${event.kernelId}`);
        if (event.event.kind.startsWith('assistant.')) {
          expect(JSON.stringify(event.event.payload)).toContain(event.kernelId);
        }
      }
    } finally {
      await registry.stopAll();
    }
  });

  it('cancels one live run without killing its runtime or disturbing the other kernel', async () => {
    const registry = new KernelSupervisorRegistry(() => ({ command: process.execPath, args: [fixture] }));
    const events: KernelStdioEvent[] = [];
    registry.on('event', event => events.push(event as KernelStdioEvent));
    try {
      await Promise.all([registry.start('openclaw'), registry.start('deepseek-harness')]);
      const openclawIdentity = identity('openclaw');
      const dshIdentity = identity('deepseek-harness');
      await Promise.all([
        registry.request('openclaw', 'session.prompt', {}, openclawIdentity),
        registry.request('deepseek-harness', 'session.prompt', {}, dshIdentity),
      ]);
      await registry.request('deepseek-harness', 'session.cancel', {}, dshIdentity);
      const [openclawTerminal, dshTerminal] = await Promise.all([
        terminal(events, openclawIdentity.runId),
        terminal(events, dshIdentity.runId),
      ]);
      expect(openclawTerminal.event.payload).toEqual({ outcome: 'completed' });
      expect(dshTerminal.event.payload).toEqual({ outcome: 'cancelled' });
      expect(await registry.request('deepseek-harness', 'runtime.health')).toEqual(expect.objectContaining({ ready: true }));
      expect(await registry.request('openclaw', 'runtime.health')).toEqual(expect.objectContaining({ ready: true }));
    } finally {
      await registry.stopAll();
    }
  });
});
