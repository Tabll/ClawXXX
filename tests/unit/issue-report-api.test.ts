// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIssueReportExporter, redactIssueReportValue } from '@electron/services/issue-report-api';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import { testAgentRouting } from '../helpers/canonical-agent';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'clawx-report-')); roots.push(value); return value; }
const diagnostics = async () => ({ kernels: [{ kernelId: 'openclaw' }, { kernelId: 'deepseek-harness' }] });
const kernelLogs = () => [{ text: 'Authorization: Basic sensitive-base64\nhttps://user:password@example.com/path' }];
const readAppLogs = async () => 'api_key=log-credential';

describe('canonical issue report export', () => {
  it('exports without conversations or a running kernel and never includes credential values', async () => {
    const output = await root();
    const exporter = createIssueReportExporter({ diagnostics, kernelLogs, readAppLogs, outputDir: async () => output });
    const result = await exporter({ conversationIds: [] });
    const zip = await JSZip.loadAsync(await readFile(result.path));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('text'));
    expect(manifest.conversationIds).toEqual([]);
    expect(manifest.privacy.nativeHistoryRead).toBe(false);
    expect(zip.file(/^conversations\//)).toHaveLength(0);
    const texts = await Promise.all(Object.values(zip.files).filter(file => !file.dir).map(file => file.async('text')));
    expect(texts.join('')).not.toMatch(/sensitive-base64|user:password|log-credential/);
    expect(await zip.file('diagnostics/kernels.json')!.async('text')).toContain('deepseek-harness');
  });

  it('exports selected canonical SQLite data across kernels and excludes private content', async () => {
    const directory = await root();
    const service = new ClawXDataService(join(directory, 'clawx.sqlite'));
    const main = service.connect({ role: 'main' });
    try {
      for (const [i, kernelId] of ['openclaw', 'deepseek-harness'].entries()) {
        const id = asConversationId(`conversation-${i}`);
        const kernel = service.connect({ role: 'kernel', kernelId, generation: 1 });
        await main.createConversation({ id, createdAt: '2026-09-19T00:00:00Z' });
        await main.admitRun({ conversationId: id, turnId: asTurnId(`turn-${i}`), runId: asRunId(`run-${i}`),
          routing: { kernelId, kernelVersion: 'test', generation: 1, ...testAgentRouting(kernelId), contextCompilerVersion: 'test/v1' },
          userBlocks: [{ id: `prompt-${i}`, type: 'text', visibility: 'portable', text: `Selected ${kernelId}` }],
          createdAt: '2026-09-19T00:00:00Z' });
        await kernel.commitTerminalRun({ conversationId: id, userTurnId: asTurnId(`turn-${i}`), assistantTurnId: asTurnId(`answer-${i}`),
          runId: asRunId(`run-${i}`), kernelId, generation: 1, outcome: 'completed', completedAt: '2026-09-19T00:00:01Z',
          assistantBlocks: [
            { id: `public-${i}`, type: 'text', visibility: 'portable', text: 'Public answer' },
            { id: `private-${i}`, type: 'text', visibility: 'private', text: 'private-should-not-export' },
            { id: `secret-${i}`, type: 'metadata', visibility: 'secret', json: { credentialRef: 'keychain://secret-should-not-export' } },
            { id: `image-${i}`, type: 'image', visibility: 'portable', json: { data: 'private-inline-image-bytes' } },
          ] });
      }
      const call = vi.fn(async (method: string, ...args: unknown[]) => (main[method as keyof typeof main] as (...values: unknown[]) => unknown)(...args));
      const exporter = createIssueReportExporter({ dataClient: { call } as never, diagnostics, kernelLogs, readAppLogs, outputDir: async () => join(directory, 'reports') });
      const result = await exporter({ conversationIds: ['conversation-0', 'conversation-1', 'gone', 'conversation-0'] });
      expect(result.conversationIds).toEqual(['conversation-0', 'conversation-1']);
      expect(result.skippedConversationIds).toEqual(['gone']);
      const zip = await JSZip.loadAsync(await readFile(result.path));
      const a = await zip.file('conversations/1.json')!.async('text');
      const b = await zip.file('conversations/2.json')!.async('text');
      expect(a).toContain('Selected openclaw');
      expect(b).toContain('Selected deepseek-harness');
      expect(a + b).not.toMatch(/private-should|secret-should|private-inline/);
      expect(new Set(call.mock.calls.map(([method]) => method))).toEqual(new Set(['getConversation', 'exportConversation']));
    } finally { await service.close(); }
  });

  it('fails on storage errors without creating a misleading partial archive and permits retry', async () => {
    const output = await root();
    const call = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const exporter = createIssueReportExporter({ dataClient: { call } as never, diagnostics, kernelLogs, readAppLogs, outputDir: async () => output });
    await expect(exporter({ conversationIds: ['selected'] })).rejects.toThrow('database unavailable');
    expect(await readdir(output)).toEqual([]);
    await expect(exporter({ conversationIds: [] })).resolves.toMatchObject({ success: true });
    await expect(exporter({ conversationIds: [null] } as never)).rejects.toThrow('Invalid');
  });

  it('redacts nested credentials, private events and inline attachment bytes', () => {
    const result = redactIssueReportValue({ appSecret: 'a', accessToken: 'b', nested: [{ visibility: 'private', text: 'hidden' }],
      image: { type: 'image', data: 'inline-image' }, error: 'proxy-authorization: Digest sensitive-digest' });
    expect(JSON.stringify(result)).not.toMatch(/sensitive-digest|inline-image|hidden|"a"|"b"/);
  });
});
