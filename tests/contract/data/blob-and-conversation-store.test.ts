// @vitest-environment node

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import { testAgentRouting } from '../../helpers/canonical-agent';

const at = (second: number) => new Date(Date.UTC(2026, 7, 23, 0, 0, second)).toISOString();

describe('canonical conversation and content-addressed Blob Store', () => {
  it('paginates/searches/exports canonical history without indexing or exporting private/secret content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-conversations-'));
    const service = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
    const main = service.connect({ role: 'main' });
    const kernel = service.connect({ role: 'kernel', kernelId: 'openclaw', generation: 1 });
    const dsh = service.connect({ role: 'kernel', kernelId: 'deepseek-harness', generation: 1 });
    try {
      for (let index = 0; index < 3; index += 1) {
        await main.createConversation({
          id: asConversationId(`conversation-${index}`),
          title: `Title ${index}`,
          createdAt: at(index),
        });
      }
      await main.admitRun({
        conversationId: asConversationId('conversation-0'),
        turnId: asTurnId('user-0'),
        runId: asRunId('run-0'),
        routing: {
          kernelId: 'openclaw', kernelVersion: 'test', generation: 1,
          ...testAgentRouting('openclaw'), contextCompilerVersion: '1',
        },
        userBlocks: [
          { id: 'portable', type: 'text', visibility: 'portable', text: 'searchable portable phrase' },
          { id: 'private', type: 'text', visibility: 'private', text: 'never-index-private' },
          { id: 'secret', type: 'metadata', visibility: 'secret', json: { credentialRef: 'keychain://account/test' } },
        ],
        createdAt: at(4),
      });
      await kernel.markRunStarted(asRunId('run-0'), at(5));
      await kernel.commitTerminalRun({
        conversationId: asConversationId('conversation-0'),
        userTurnId: asTurnId('user-0'),
        assistantTurnId: asTurnId('assistant-0'),
        runId: asRunId('run-0'),
        kernelId: 'openclaw',
        generation: 1,
        outcome: 'completed',
        assistantBlocks: [{ id: 'answer', type: 'text', visibility: 'portable', text: 'answer' }],
        completedAt: at(6),
      });
      await main.admitRun({
        conversationId: asConversationId('conversation-0'),
        turnId: asTurnId('user-1'),
        runId: asRunId('run-1'),
        routing: {
          kernelId: 'deepseek-harness', kernelVersion: 'test', generation: 1,
          ...testAgentRouting('deepseek-harness', {
            agentId: 'research',
            workspaceUri: 'file:///tmp/research',
          }),
          contextCompilerVersion: '1',
        },
        userBlocks: [{ id: 'portable-2', type: 'text', visibility: 'portable', text: 'continue portably' }],
        createdAt: at(7),
      });
      await dsh.markRunStarted(asRunId('run-1'), at(8));
      await dsh.commitTerminalRun({
        conversationId: asConversationId('conversation-0'),
        userTurnId: asTurnId('user-1'),
        assistantTurnId: asTurnId('assistant-1'),
        runId: asRunId('run-1'),
        kernelId: 'deepseek-harness',
        generation: 1,
        outcome: 'completed',
        assistantBlocks: [{ id: 'answer-2', type: 'text', visibility: 'portable', text: 'continued answer' }],
        completedAt: at(9),
      });

      const first = await main.listConversations({ limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBeDefined();
      expect((await main.listConversations({ limit: 2, cursor: first.nextCursor })).items).toHaveLength(1);
      expect((await main.searchConversations('searchable portable')).map(row => row.id)).toEqual(['conversation-0']);
      expect(await main.getConversation(asConversationId('conversation-0'))).toEqual(expect.objectContaining({
        lastKernelId: 'deepseek-harness',
        kernelIds: expect.arrayContaining(['openclaw', 'deepseek-harness']),
        lastAgentId: 'research',
        workspaceUri: 'file:///tmp/research',
      }));
      expect((await main.listConversations({ limit: 10, lastKernelId: 'deepseek-harness' })).items.map(row => row.id))
        .toContain('conversation-0');
      expect((await main.listConversations({ limit: 10, lastKernelId: 'openclaw' })).items.map(row => row.id))
        .not.toContain('conversation-0');
      expect((await main.listConversations({ limit: 10, participatedKernelId: 'openclaw' })).items.map(row => row.id))
        .toContain('conversation-0');
      expect((await main.listConversations({ limit: 10, agentId: 'research' })).items.map(row => row.id))
        .toContain('conversation-0');
      expect((await main.searchConversations('searchable portable', 50, {
        participatedKernelId: 'deepseek-harness',
        workspaceUri: 'file:///tmp/research',
      })).map(row => row.id)).toEqual(['conversation-0']);
      expect(await main.searchConversations('never-index-private')).toEqual([]);
      await main.renameConversation(asConversationId('conversation-0'), 'Renamed', at(10));
      await main.pinConversation(asConversationId('conversation-0'), at(11), at(11));
      const exported = await main.exportConversation(asConversationId('conversation-0'));
      expect(exported.conversation).toEqual(expect.objectContaining({ title: 'Renamed', pinnedAt: at(11) }));
      expect((await main.listConversations({ limit: 10, pinned: true })).items.map(row => row.id))
        .toContain('conversation-0');
      expect(JSON.stringify(exported)).toContain('never-index-private');
      expect(JSON.stringify(exported)).not.toContain('keychain://account/test');
      await expect(main.admitRun({
        conversationId: asConversationId('conversation-1'),
        turnId: asTurnId('bad-secret-turn'),
        runId: asRunId('bad-secret-run'),
        routing: {
          kernelId: 'openclaw', kernelVersion: 'test', generation: 1,
          ...testAgentRouting('openclaw'), contextCompilerVersion: '1',
        },
        userBlocks: [{ id: 'bad-secret', type: 'text', visibility: 'secret', text: 'plaintext secret' }],
        createdAt: at(12),
      })).rejects.toThrow(/opaque keychain credentialRef/);
    } finally {
      await service.close();
    }
  });

  it('walks the pinned and unpinned sort order without cursor gaps or duplicates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-conversation-cursor-'));
    const service = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
    const main = service.connect({ role: 'main' });
    try {
      for (let index = 0; index < 6; index += 1) {
        await main.createConversation({
          id: asConversationId(`cursor-${index}`),
          title: `Cursor ${index}`,
          createdAt: at(index),
        });
      }
      // Pin timestamps intentionally disagree with updated_at/id order so the
      // cursor must carry every ORDER BY component.
      await main.pinConversation(asConversationId('cursor-1'), at(20), at(2));
      await main.pinConversation(asConversationId('cursor-4'), at(10), at(5));

      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await main.listConversations({ limit: 1, ...(cursor ? { cursor } : {}) });
        ids.push(...page.items.map(item => item.id));
        cursor = page.nextCursor;
      } while (cursor);

      expect(ids).toEqual([
        'cursor-1',
        'cursor-4',
        'cursor-5',
        'cursor-3',
        'cursor-2',
        'cursor-0',
      ]);
      expect(new Set(ids).size).toBe(6);
      await expect(main.listConversations({ limit: 1, cursor: 'not-a-valid-cursor' }))
        .rejects.toThrow('Invalid conversation page cursor');
    } finally {
      await service.close();
    }
  });

  it('verifies hashes, enforces run-scoped grants, and only collects unreferenced blobs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-blobs-'));
    const service = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
    const main = service.connect({ role: 'main' });
    const openclaw = service.connect({ role: 'kernel', kernelId: 'openclaw', generation: 1 });
    const dsh = service.connect({ role: 'kernel', kernelId: 'deepseek-harness', generation: 1 });
    try {
      const retained = await main.putBlob({ data: new TextEncoder().encode('retained'), mimeType: 'text/plain', createdAt: at(0) });
      const garbage = await main.putBlob({ data: new TextEncoder().encode('garbage'), mimeType: 'text/plain', createdAt: at(0) });
      await main.addBlobRef({
        ownerType: 'test', ownerId: 'retained', blobHash: retained.hash, accessPolicy: { read: 'grant-only' }, createdAt: at(0),
      });
      await main.createConversation({ id: asConversationId('blob-conversation'), createdAt: at(0) });
      await main.admitRun({
        conversationId: asConversationId('blob-conversation'),
        turnId: asTurnId('blob-turn'),
        runId: asRunId('blob-run'),
        routing: {
          kernelId: 'openclaw', kernelVersion: 'test', generation: 1,
          ...testAgentRouting('openclaw'), contextCompilerVersion: '1',
        },
        userBlocks: [{ id: 'blob-block', type: 'resource-link', visibility: 'portable', blobHash: retained.hash }],
        createdAt: at(1),
      });
      await main.createAttachmentGrant({
        id: 'grant', blobHash: retained.hash, runId: asRunId('blob-run'), kernelId: 'openclaw', generation: 1,
        createdAt: at(1), expiresAt: at(30),
      });
      expect(new TextDecoder().decode(await openclaw.readBlob({
        grantId: 'grant', blobHash: retained.hash, runId: asRunId('blob-run'), now: at(2),
      }))).toBe('retained');
      await expect(dsh.readBlob({
        grantId: 'grant', blobHash: retained.hash, runId: asRunId('blob-run'), now: at(2),
      })).rejects.toThrow(/outside kernel scope/);
      expect(await main.getConversationBlobMetadata({
        conversationId: asConversationId('blob-conversation'),
        blobHash: retained.hash,
      })).toEqual({ mimeType: 'text/plain', size: 8 });
      expect(new TextDecoder().decode((await main.readConversationBlob({
        conversationId: asConversationId('blob-conversation'),
        blobHash: retained.hash,
      })).data)).toBe('retained');
      await main.createConversation({ id: asConversationId('unrelated-conversation'), createdAt: at(2) });
      await expect(main.readConversationBlob({
        conversationId: asConversationId('unrelated-conversation'),
        blobHash: retained.hash,
      })).rejects.toThrow(/not readable/);
      await expect(openclaw.readConversationBlob({
        conversationId: asConversationId('blob-conversation'),
        blobHash: retained.hash,
      })).rejects.toThrow(/Only Main/);
      expect(await main.garbageCollectBlobs()).toEqual([garbage.hash]);

      const deleted = await main.putBlob({
        data: new TextEncoder().encode('hard-delete-me'), mimeType: 'text/plain', createdAt: at(3),
      });
      await main.createConversation({ id: asConversationId('hard-delete-conversation'), createdAt: at(3) });
      await main.admitRun({
        conversationId: asConversationId('hard-delete-conversation'),
        turnId: asTurnId('hard-delete-turn'),
        runId: asRunId('hard-delete-run'),
        routing: {
          kernelId: 'openclaw', kernelVersion: 'test', generation: 1,
          ...testAgentRouting('openclaw'), contextCompilerVersion: '1',
        },
        userBlocks: [{ id: 'hard-delete-block', type: 'resource-link', visibility: 'portable', blobHash: deleted.hash }],
        createdAt: at(3),
      });
      expect(existsSync(deleted.path)).toBe(true);
      await main.deleteConversation(asConversationId('hard-delete-conversation'), at(4), true);
      expect(existsSync(deleted.path)).toBe(false);
      expect(await main.garbageCollectBlobs()).toEqual([]);

      writeFileSync(retained.path, 'tampered');
      await expect(openclaw.readBlob({
        grantId: 'grant', blobHash: retained.hash, runId: asRunId('blob-run'), now: at(2),
      })).rejects.toThrow(/hash verification failed/);
    } finally {
      await service.close();
    }
  });

  it('creates an explicit lineage branch with inherited history and independent run lease', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-branch-'));
    const service = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
    const main = service.connect({ role: 'main' });
    const openclaw = service.connect({ role: 'kernel', kernelId: 'openclaw', generation: 1 });
    const dsh = service.connect({ role: 'kernel', kernelId: 'deepseek-harness', generation: 1 });
    try {
      await main.createConversation({
        id: asConversationId('source-conversation'),
        title: 'Source',
        createdAt: at(0),
      });
      await main.admitRun({
        conversationId: asConversationId('source-conversation'),
        turnId: asTurnId('source-user'),
        runId: asRunId('source-run'),
        routing: {
          kernelId: 'openclaw', kernelVersion: 'openclaw-test', generation: 1,
          ...testAgentRouting('openclaw'), contextCompilerVersion: '1',
        },
        userBlocks: [{ id: 'source-prompt', type: 'text', visibility: 'portable', text: 'source prompt' }],
        createdAt: at(1),
      });
      await openclaw.markRunStarted(asRunId('source-run'), at(2));
      await openclaw.commitTerminalRun({
        conversationId: asConversationId('source-conversation'),
        userTurnId: asTurnId('source-user'),
        assistantTurnId: asTurnId('source-assistant'),
        runId: asRunId('source-run'),
        kernelId: 'openclaw',
        generation: 1,
        outcome: 'completed',
        assistantBlocks: [{ id: 'source-answer', type: 'text', visibility: 'portable', text: 'source answer' }],
        completedAt: at(3),
      });

      const branch = await main.branchConversation({
        sourceConversationId: asConversationId('source-conversation'),
        sourceTurnId: asTurnId('source-assistant'),
        branchConversationId: asConversationId('comparison-branch'),
        title: 'Comparison',
        createdAt: at(4),
      });
      expect(branch).toMatchObject({
        id: 'comparison-branch',
        parentConversationId: 'source-conversation',
        branchedFromTurnId: 'source-assistant',
      });
      await main.admitRun({
        conversationId: asConversationId('comparison-branch'),
        turnId: asTurnId('branch-user'),
        runId: asRunId('branch-run'),
        routing: {
          kernelId: 'deepseek-harness', kernelVersion: 'dsh-test', generation: 1,
          ...testAgentRouting('deepseek-harness'), contextCompilerVersion: '1',
        },
        userBlocks: [{ id: 'branch-prompt', type: 'text', visibility: 'portable', text: 'compare this' }],
        createdAt: at(5),
      });
      const context = await dsh.compileContext({
        conversationId: asConversationId('comparison-branch'),
        runId: asRunId('branch-run'),
      });
      expect(context.blocks.map(block => block.text).filter(Boolean)).toEqual([
        'source prompt', 'source answer', 'compare this',
      ]);
      const exported = await main.exportConversation(asConversationId('comparison-branch'));
      expect(exported.turns.map(turn => turn.id)).toEqual([
        'source-user', 'source-assistant', 'branch-user',
      ]);
      expect(exported.runs.map(run => [run.id, run.kernelId])).toEqual([
        ['source-run', 'openclaw'],
        ['branch-run', 'deepseek-harness'],
      ]);
      await expect(main.branchConversation({
        sourceConversationId: asConversationId('source-conversation'),
        sourceTurnId: asTurnId('source-user'),
        branchConversationId: asConversationId('invalid-branch'),
        createdAt: at(6),
      })).rejects.toThrow(/completed assistant turn/);
    } finally {
      await service.close();
    }
  });
});
