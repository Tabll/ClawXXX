import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { asConversationId, type ConversationExport } from '@shared/conversations/contracts';
import type { IssueReportExportPayload, IssueReportExportResult } from '@shared/host-api/contract';
import type { RemoteDataServiceClient } from '../data/data-service-utility-host';
import { redactDiagnosticText } from '../kernels/log-redaction';
import { logger } from '../utils/logger';

type IssueReportDependencies = {
  dataClient?: RemoteDataServiceClient;
  diagnostics: () => Promise<unknown>;
  kernelLogs: () => unknown;
  readAppLogs?: () => Promise<string>;
  outputDir?: () => Promise<string>;
  now?: () => Date;
};

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const SENSITIVE_KEY = /(?:apikey|secret|password|passwd|passphrase|credential|credentials|authorization|cookie|privatekey|accesstoken|refreshtoken|authtoken|bearertoken|bottoken|gatewaytoken)$|^token$/i;

/** Reports contain selected content only; never load native runtime histories. */
export function redactIssueReportValue(value: unknown): unknown {
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.map(redactIssueReportValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.visibility === 'private' || record.visibility === 'secret' || record.revoked === true) return '[omitted]';
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    SENSITIVE_KEY.test(key.replace(/[^a-z0-9]/gi, '')) ? '[redacted]'
      : key === 'data' && (record.type === 'image' || record.type === 'audio') ? '[attachment omitted]'
        : redactIssueReportValue(child),
  ]));
}

function reportConversation(history: ConversationExport): unknown {
  return redactIssueReportValue({
    ...history,
    turns: history.turns.map(turn => ({
      ...turn,
      blocks: turn.blocks
        .filter(block => !block.revoked && block.visibility !== 'private' && block.visibility !== 'secret')
        .map(block => block.type === 'image' ? { ...block, json: undefined } : block),
    })),
    runs: history.runs.map(run => ({
      ...run,
      // Agent instructions and private reasoning are unnecessary for a report.
      agentSnapshot: { agentId: run.agentSnapshot.agentId, displayName: run.agentSnapshot.displayName },
      events: run.events.filter(event => event.kind !== 'reasoning.visibility'),
    })),
  });
}

function selectedIds(payload: IssueReportExportPayload): string[] {
  if (!payload || !Array.isArray(payload.conversationIds) || payload.conversationIds.length > 500
    || payload.conversationIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 512)) {
    throw new Error('Invalid Conversation selection');
  }
  return [...new Set(payload.conversationIds.map(id => id.trim()))];
}

export function createIssueReportExporter(deps: IssueReportDependencies) {
  let exporting = false;
  return async (payload: IssueReportExportPayload): Promise<IssueReportExportResult> => {
    const ids = selectedIds(payload);
    if (exporting) throw new Error('An issue report is already being exported');
    exporting = true;
    try {
      const now = deps.now?.() ?? new Date();
      const zip = new JSZip();
      let bytes = 0;
      const includedFiles: string[] = [];
      const conversationIds: string[] = [];
      const skippedConversationIds: string[] = [];
      const add = (path: string, value: unknown) => {
        const content = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
        bytes += Buffer.byteLength(content);
        if (bytes > MAX_REPORT_BYTES) throw new Error('Issue report exceeds 64 MiB; select fewer Conversations');
        zip.file(path, content);
        includedFiles.push(path);
      };
      add('diagnostics/kernels.json', redactIssueReportValue(await deps.diagnostics()));
      add('diagnostics/kernel-logs.json', redactIssueReportValue(deps.kernelLogs()));
      add('diagnostics/clawx.log', redactDiagnosticText(await (deps.readAppLogs?.() ?? logger.readLogFile(200))));
      for (const id of ids) {
        if (!deps.dataClient) throw new Error('ClawX DataService is not available');
        const summary = await deps.dataClient.call('getConversation', asConversationId(id));
        if (!summary) { skippedConversationIds.push(id); continue; }
        let history: ConversationExport;
        try { history = await deps.dataClient.call('exportConversation', asConversationId(id)); }
        catch (error) {
          if (await deps.dataClient.call('getConversation', asConversationId(id))) throw error;
          skippedConversationIds.push(id);
          continue;
        }
        add(`conversations/${conversationIds.length + 1}.json`, reportConversation(history));
        conversationIds.push(id);
      }
      add('manifest.json', {
        schema: 'clawx.issue-report/v1', createdAt: now.toISOString(),
        conversationIds, skippedConversationIds, includedFiles: [...includedFiles],
        limits: { totalBytes: MAX_REPORT_BYTES, diagnosticStringCharacters: 16_384, appLogTailLines: 200 },
        privacy: {
          knownSecretsRedacted: true, privateBlocksOmitted: true, privateReasoningOmitted: true,
          attachmentBytesIncluded: false, nativeHistoryRead: false,
          selectedContentMayContainPersonalInformation: true,
        },
      });
      const outputDir = await (deps.outputDir?.() ?? import('electron').then(({ app }) => app.getPath('desktop')));
      await mkdir(outputDir, { recursive: true });
      const stamp = now.toISOString().replace(/[:.]/g, '-');
      const path = join(outputDir, `clawx-issue-report-${stamp}-${randomUUID().slice(0, 8)}.zip`);
      await writeFile(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), { flag: 'wx', mode: 0o600 });
      return { success: true, path, conversationIds, skippedConversationIds };
    } finally { exporting = false; }
  };
}
