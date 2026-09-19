// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import { testAgentRouting } from '../../helpers/canonical-agent';

it('keeps nested child lineage through restart, caps depth, and preserves independent children after parent deletion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clawx-lineage-'));
  const path = join(root, 'state.sqlite'); const createdAt = new Date().toISOString();
  let service = new ClawXDataService(path);
  try {
    let main = service.connect({ role: 'main' });
    for (let depth = 0; depth < 5; depth++) {
      await main.createConversation({ id: asConversationId(`c${depth}`), createdAt });
      const operation = main.admitRun({ conversationId: asConversationId(`c${depth}`), turnId: asTurnId(`t${depth}`), runId: asRunId(`r${depth}`),
        ...(depth ? { parentRunId: asRunId(`r${depth - 1}`) } : {}),
        routing: { kernelId: 'deepseek-harness', kernelVersion: 'fixture', generation: 1, ...testAgentRouting('deepseek-harness'), contextCompilerVersion: '1' },
        userBlocks: [{ id: `b${depth}`, type: 'text', text: `independent ${depth}`, visibility: 'portable' }], createdAt });
      if (depth === 4) await expect(operation).rejects.toThrow('Invalid child run admission'); else await operation;
    }
    expect((await main.exportConversation(asConversationId('c4'))).turns).toHaveLength(0);
    await service.close(); service = new ClawXDataService(path); main = service.connect({ role: 'main' });
    expect(await main.listChildRuns(asConversationId('c1'))).toEqual([expect.objectContaining({ parentRunId: 'r1', runId: 'r2', status: 'interrupted' })]);
    const child = await main.exportConversation(asConversationId('c2'));
    expect(child.conversation.parentConversationId).toBeUndefined();
    expect(child.turns).toHaveLength(1); expect(child.turns[0].blocks[0].text).toBe('independent 2');
    await main.deleteConversation(asConversationId('c1'), createdAt, true);
    expect((await main.exportConversation(asConversationId('c2'))).turns).toHaveLength(1);
    expect(await main.listChildRuns(asConversationId('c1'))).toEqual([]);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
