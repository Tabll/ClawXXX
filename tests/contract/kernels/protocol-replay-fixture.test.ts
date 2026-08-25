// @vitest-environment node

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import type { KernelEventEnvelopeV1, KernelId } from '@shared/kernels/contracts';
import { testAgentRouting } from '../../helpers/canonical-agent';

const fixturePath = new URL('../../fixtures/kernels/replay/multi-kernel-events.jsonl', import.meta.url);

function admission(kernelId: KernelId) {
  const suffix = kernelId === 'openclaw' ? 'openclaw' : 'dsh';
  return {
    conversationId: asConversationId(`conversation-${suffix}`),
    turnId: asTurnId(`turn-${suffix}`),
    runId: asRunId(`run-${suffix}`),
    routing: {
      kernelId,
      kernelVersion: 'fixture',
      generation: 1,
      ...testAgentRouting(kernelId),
      contextCompilerVersion: 'test/v1',
    },
    userBlocks: [{ id: `block-${suffix}`, type: 'text' as const, visibility: 'portable' as const, text: suffix }],
    createdAt: '2026-08-23T00:00:00.000Z',
  };
}

describe('multi-kernel protocol/store replay fixture', () => {
  it('scopes identical native IDs by canonical run and deduplicates exact interleaved replays', async () => {
    const events = readFileSync(fixturePath, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as KernelEventEnvelopeV1);
    const root = mkdtempSync(join(tmpdir(), 'clawx-replay-'));
    const service = new ClawXDataService(join(root, 'clawx.sqlite'));
    const main = service.connect({ role: 'main' });
    const openclaw = service.connect({ role: 'kernel', kernelId: 'openclaw', generation: 1 });
    const dsh = service.connect({ role: 'kernel', kernelId: 'deepseek-harness', generation: 1 });
    try {
      for (const kernelId of ['openclaw', 'deepseek-harness'] as const) {
        const suffix = kernelId === 'openclaw' ? 'openclaw' : 'dsh';
        await main.createConversation({
          id: asConversationId(`conversation-${suffix}`),
          createdAt: '2026-08-23T00:00:00.000Z',
        });
        await main.admitRun(admission(kernelId));
      }
      let inserted = 0;
      let duplicates = 0;
      for (const event of events) {
        const client = event.kernelId === 'openclaw' ? openclaw : dsh;
        const result = await client.appendEvents([event]);
        inserted += result.inserted;
        duplicates += result.duplicates;
      }
      expect({ inserted, duplicates }).toEqual({ inserted: 4, duplicates: 2 });
      expect(await main.listRunEvents(asRunId('run-openclaw'))).toHaveLength(2);
      expect(await main.listRunEvents(asRunId('run-dsh'))).toHaveLength(2);
    } finally {
      await service.close();
    }
  });
});
