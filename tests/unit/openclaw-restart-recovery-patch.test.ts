// @vitest-environment node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const execFileAsync = promisify(execFile);

function assertValidUnifiedDiffHunks(patch: string): void {
  const lines = patch.split('\n');
  let hunkCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[index] ?? '');
    if (!header) continue;

    hunkCount += 1;
    const expectedOld = Number(header[1] ?? 1);
    const expectedNew = Number(header[2] ?? 1);
    let oldLines = 0;
    let newLines = 0;

    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.startsWith('@@ ') || line.startsWith('diff --git ')) {
        index -= 1;
        break;
      }
      if (line === '' && index === lines.length - 1) break;
      if (line.startsWith(' ')) {
        oldLines += 1;
        newLines += 1;
      } else if (line.startsWith('-')) {
        oldLines += 1;
      } else if (line.startsWith('+')) {
        newLines += 1;
      } else if (!line.startsWith('\\')) {
        throw new Error(`Invalid unified diff line ${index + 1}: ${line}`);
      }
    }

    expect({ oldLines, newLines }).toEqual({
      oldLines: expectedOld,
      newLines: expectedNew,
    });
  }

  expect(hunkCount).toBeGreaterThan(0);
}

describe('OpenClaw managed recovery patch', () => {
  it('freezes the exact rebased patch and rejects malformed hunks', async () => {
    const workspace = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    const lockfile = await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8');
    const patch = await readFile(path.join(root, 'patches/openclaw@2026.9.2.patch'), 'utf8');
    expect(workspace).toContain('openclaw@2026.9.2: patches/openclaw@2026.9.2.patch');
    expect(lockfile).toContain('hash: ' + createHash('sha256').update(patch).digest('hex'));
    assertValidUnifiedDiffHunks(patch);
  });

  it('replaces native restart/replay with canonical per-Run hydration in managed mode only', async () => {
    const bundle = await readFile(path.join(root, 'node_modules/openclaw/dist/server-zrB9dRww.js'), 'utf8');
    expect(bundle).toContain('createInMemoryAcpEventLedger');
    expect(bundle).toContain('clawx.session.hydrate');
    expect(bundle).toContain('"sessions.messages.subscribe"');
    expect(bundle).toContain('evt.event === "session.tool"');
    expect(bundle).toContain('suppressCommandInterpretation');
    expect(bundle).toContain('clawxPrompted');
    expect(bundle).toContain('"sessions.delete"');
    expect(bundle).toContain('canonical run interrupted');
    // Non-managed upstream recovery remains available; the guard selects the
    // fail-closed managed path instead of persisting/replaying a second history.
    expect(bundle).toContain('createSqliteAcpEventLedger');
  });

  it('uses actual provider usage, never a session-store estimate or replay charge', async () => {
    const runtime = await readFile(path.join(root, 'node_modules/openclaw/dist/builtin-openclaw-B_H1oNzF.js'), 'utf8');
    const translator = await readFile(path.join(root, 'node_modules/openclaw/dist/server-zrB9dRww.js'), 'utf8');
    expect(runtime).toContain('recordModelUsage(pending, message)');
    expect(runtime).toContain('source: "provider-response"');
    expect(runtime).toContain('hasNonzeroUsage(usage) || usage.cost?.totalOrigin === "provider-billed"');
    expect(runtime).toContain('if (clawxUsage.cost?.totalOrigin !== "provider-billed") delete clawxUsage.cost');
    expect(runtime).toContain('message.provider');
    expect(runtime).toContain('message.model');
    expect(translator).toContain('this.findPendingBySessionKey(sessionKey, runId)');
    expect(translator).toContain('typeof data.eventKey !== "string"');
  });

  it('retains upstream trusted execution identity in real approval request construction', async () => {
    const bundle = await readFile(path.join(root, 'node_modules/openclaw/dist/bash-tools.exec-approval-request-DYkIh7HP.js'), 'utf8');
    const start = bundle.indexOf('function buildExecApprovalRequestToolParams(params)');
    const end = bundle.indexOf('\nfunction parseDecision', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const context = {
      DEFAULT_APPROVAL_TIMEOUT_MS: 60_000,
      buildExecApprovalRequestToolParams: undefined as ((params: Record<string, unknown>) => Record<string, unknown>) | undefined,
    };
    runInNewContext(bundle.slice(start, end) + '\nglobalThis.buildExecApprovalRequestToolParams = buildExecApprovalRequestToolParams;', context);
    expect(context.buildExecApprovalRequestToolParams?.({ id: 'approval', sessionKey: 'scoped', sessionId: 'native', runId: 'canonical-run', toolCallId: 'tool' }))
      .toMatchObject({ id: 'approval', sessionKey: 'scoped', sessionId: 'native', runId: 'canonical-run', toolCallId: 'tool', timeoutMs: 60_000, twoPhase: true });
  });

  it('keeps every patched executable syntactically valid and survives upstream lifecycle pruning', async () => {
    const patch = await readFile(path.join(root, 'patches/openclaw@2026.9.2.patch'), 'utf8');
    const files = [...patch.matchAll(/^diff --git a\/(.+) b\/.+$/gm)].map(match => match[1]);
    for (const file of files.filter(file => /\.(?:mjs|js)$/.test(file))) {
      await expect(execFileAsync(process.execPath, ['--check', path.join(root, 'node_modules/openclaw', file)]))
        .resolves.toMatchObject({ stderr: '' });
    }
    const inventory = JSON.parse(await readFile(path.join(root, 'node_modules/openclaw/dist/postinstall-inventory.json'), 'utf8'));
    for (const file of ['dist/clawx-managed-storage.js', 'dist/plugin-sdk/clawx-legacy-core.js', 'dist/plugin-sdk/channel-runtime.js', 'dist/plugin-sdk/text-runtime.js']) {
      expect(inventory).toContain(file);
    }
  });
});
