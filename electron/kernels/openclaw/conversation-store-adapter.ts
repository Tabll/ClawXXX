import type { KernelContextBlock, KernelContextSnapshotV1, TurnId } from '@shared/conversations/contracts';

export const OPENCLAW_CHECKPOINT_CODEC = 'clawx.openclaw.session-manager/v1' as const;
export const OPENCLAW_CHECKPOINT_SCHEMA_VERSION = 1 as const;

type OpenClawEntryBase = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
};

export type OpenClawSessionEntry = OpenClawEntryBase & Record<string, unknown>;

export type OpenClawSessionCheckpointV1 = {
  protocol: typeof OPENCLAW_CHECKPOINT_CODEC;
  schemaVersion: typeof OPENCLAW_CHECKPOINT_SCHEMA_VERSION;
  cwd: string;
  entries: OpenClawSessionEntry[];
  leafId: string | null;
  canonicalTurnIds: string[];
};

export interface OpenClawSessionManagerLike {
  isPersisted(): boolean;
  getCwd(): string;
  /** July releases exposed a file; September releases expose a SQLite target. */
  getSessionFile?(): string | undefined;
  getSessionTarget?(): unknown;
  getLeafId(): string | null;
  getEntries(): OpenClawSessionEntry[];
  getTree(): unknown[];
  buildSessionContext(): { messages: unknown[] };
  resetLeaf(): void;
  branch(entryId: string): void;
  appendMessage(message: unknown): string;
  appendThinkingLevelChange(level: string): string;
  appendModelChange(provider: string, modelId: string): string;
  appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: unknown, fromHook?: boolean): string;
  appendCustomEntry(customType: string, data?: unknown): string;
  appendCustomMessageEntry(customType: string, content: unknown, display: boolean, details?: unknown): string;
  appendSessionInfo(name: string): string;
  appendLabelChange(targetId: string, label: string | undefined): string;
  branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): string;
}

export type OpenClawSessionManagerFactory = {
  inMemory(cwd?: string): OpenClawSessionManagerLike;
};

export function assertInMemoryOpenClawSessionManager(
  manager: Pick<OpenClawSessionManagerLike, 'isPersisted' | 'getSessionFile' | 'getSessionTarget'>,
): void {
  // Do not treat a removed/unknown persistence API as proof of in-memory use.
  if (
    (typeof manager.getSessionFile !== 'function' && typeof manager.getSessionTarget !== 'function')
    || typeof manager.isPersisted !== 'function'
    || manager.isPersisted() !== false
    || (typeof manager.getSessionFile === 'function' && manager.getSessionFile() !== undefined)
    || (typeof manager.getSessionTarget === 'function' && manager.getSessionTarget() !== undefined)
  ) {
    throw new Error('Managed OpenClaw sessions must be strictly in-memory');
  }
}

function assertCheckpoint(value: unknown): asserts value is OpenClawSessionCheckpointV1 {
  if (!value || typeof value !== 'object') throw new Error('OpenClaw checkpoint must be an object');
  const checkpoint = value as Partial<OpenClawSessionCheckpointV1>;
  if (
    checkpoint.protocol !== OPENCLAW_CHECKPOINT_CODEC
    || checkpoint.schemaVersion !== OPENCLAW_CHECKPOINT_SCHEMA_VERSION
    || typeof checkpoint.cwd !== 'string'
    || !Array.isArray(checkpoint.entries)
    || !Array.isArray(checkpoint.canonicalTurnIds)
    || !(checkpoint.leafId === null || typeof checkpoint.leafId === 'string')
  ) {
    throw new Error('OpenClaw checkpoint identity or shape is incompatible');
  }
}

function textForBlocks(blocks: KernelContextBlock[]): string {
  return blocks.map((block) => {
    if (block.text !== undefined) return block.text;
    if (block.json !== undefined) return JSON.stringify(block.json);
    if (block.blobHash) return `[ClawX attachment ${block.blobHash}]`;
    return '';
  }).filter(Boolean).join('\n');
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function canonicalMessage(turnId: string, role: KernelContextBlock['role'], blocks: KernelContextBlock[]): unknown {
  const text = textForBlocks(blocks);
  const timestamp = Date.now();
  if (role === 'user') return { role: 'user', content: text, timestamp };
  if (role === 'assistant') {
    return {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'openai-completions',
      provider: 'clawx-canonical-history',
      model: 'portable-context-v1',
      usage: zeroUsage(),
      stopReason: 'stop',
      timestamp,
    };
  }
  const metadata = blocks.find((block) => block.type === 'tool-result')?.json;
  const record = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
  return {
    role: 'toolResult',
    toolCallId: typeof record.toolCallId === 'string' ? record.toolCallId : `clawx-${turnId}`,
    toolName: typeof record.toolName === 'string' ? record.toolName : 'clawx-portable-tool',
    content: [{ type: 'text', text }],
    isError: record.isError === true,
    timestamp,
  };
}

function positionForParent(
  manager: OpenClawSessionManagerLike,
  parentId: string | null,
  idMap: Map<string, string>,
): void {
  if (parentId === null) {
    manager.resetLeaf();
    return;
  }
  const mapped = idMap.get(parentId);
  if (!mapped) throw new Error(`OpenClaw checkpoint parent is missing: ${parentId}`);
  manager.branch(mapped);
}

function replayEntry(
  manager: OpenClawSessionManagerLike,
  entry: OpenClawSessionEntry,
  idMap: Map<string, string>,
): string {
  const parentId = entry.parentId;
  if (entry.type === 'branch_summary') {
    const fromId = typeof entry.fromId === 'string' && entry.fromId !== 'root'
      ? idMap.get(entry.fromId)
      : null;
    if (typeof entry.fromId === 'string' && entry.fromId !== 'root' && !fromId) {
      throw new Error(`OpenClaw branch summary target is missing: ${entry.fromId}`);
    }
    return manager.branchWithSummary(
      fromId ?? null,
      String(entry.summary ?? ''),
      entry.details,
      entry.fromHook === true,
    );
  }

  positionForParent(manager, parentId, idMap);
  switch (entry.type) {
    case 'message':
      return manager.appendMessage(structuredClone(entry.message));
    case 'thinking_level_change':
      return manager.appendThinkingLevelChange(String(entry.thinkingLevel ?? 'medium'));
    case 'model_change':
      return manager.appendModelChange(String(entry.provider ?? ''), String(entry.modelId ?? ''));
    case 'compaction': {
      const firstKeptEntryId = idMap.get(String(entry.firstKeptEntryId));
      if (!firstKeptEntryId) throw new Error(`OpenClaw compaction target is missing: ${String(entry.firstKeptEntryId)}`);
      return manager.appendCompaction(
        String(entry.summary ?? ''),
        firstKeptEntryId,
        Number(entry.tokensBefore ?? 0),
        entry.details,
        entry.fromHook === true,
      );
    }
    case 'custom':
      return manager.appendCustomEntry(String(entry.customType ?? ''), structuredClone(entry.data));
    case 'custom_message':
      return manager.appendCustomMessageEntry(
        String(entry.customType ?? ''),
        structuredClone(entry.content),
        entry.display === true,
        structuredClone(entry.details),
      );
    case 'session_info':
      return manager.appendSessionInfo(String(entry.name ?? ''));
    case 'label': {
      const target = idMap.get(String(entry.targetId));
      if (!target) throw new Error(`OpenClaw label target is missing: ${String(entry.targetId)}`);
      return manager.appendLabelChange(target, typeof entry.label === 'string' ? entry.label : undefined);
    }
    default:
      throw new Error(`Unsupported OpenClaw checkpoint entry type: ${entry.type}`);
  }
}

export class OpenClawConversationSession {
  readonly manager: OpenClawSessionManagerLike;
  private readonly canonicalTurnIds: Set<string>;

  private constructor(manager: OpenClawSessionManagerLike, canonicalTurnIds: Iterable<string>) {
    assertInMemoryOpenClawSessionManager(manager);
    this.manager = manager;
    this.canonicalTurnIds = new Set(canonicalTurnIds);
  }

  static hydrate(input: {
    factory: OpenClawSessionManagerFactory;
    cwd: string;
    snapshot: KernelContextSnapshotV1;
    checkpoint?: unknown;
  }): OpenClawConversationSession {
    if (input.snapshot.kernelId !== 'openclaw') throw new Error('OpenClaw adapter received another kernel context');
    const manager = input.factory.inMemory(input.cwd);
    const included = new Set<string>();

    if (input.checkpoint !== undefined) {
      assertCheckpoint(input.checkpoint);
      const idMap = new Map<string, string>();
      for (const entry of input.checkpoint.entries) {
        if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.type !== 'string') {
          throw new Error('OpenClaw checkpoint contains an invalid entry');
        }
        idMap.set(entry.id, replayEntry(manager, entry, idMap));
      }
      if (input.checkpoint.leafId === null) manager.resetLeaf();
      else {
        const leaf = idMap.get(input.checkpoint.leafId);
        if (!leaf) throw new Error(`OpenClaw checkpoint leaf is missing: ${input.checkpoint.leafId}`);
        manager.branch(leaf);
      }
      for (const turnId of input.checkpoint.canonicalTurnIds) included.add(turnId);
    }

    const session = new OpenClawConversationSession(manager, included);
    session.appendSnapshot(input.snapshot);
    return session;
  }

  appendSnapshot(snapshot: KernelContextSnapshotV1): void {
    const groups = new Map<string, KernelContextBlock[]>();
    for (const block of snapshot.blocks) {
      if (block.visibility === 'private' || block.visibility === 'secret') {
        throw new Error(`Context compiler leaked forbidden block ${block.id}`);
      }
      const blocks = groups.get(block.turnId) ?? [];
      blocks.push(block);
      groups.set(block.turnId, blocks);
    }
    for (const [turnId, blocks] of groups) {
      if (this.canonicalTurnIds.has(turnId)) continue;
      blocks.sort((left, right) => left.position - right.position);
      this.manager.appendMessage(canonicalMessage(turnId, blocks[0]!.role, blocks));
      this.canonicalTurnIds.add(turnId);
    }
  }

  markCanonicalTurnIncluded(turnId: TurnId): void {
    this.canonicalTurnIds.add(turnId);
  }

  checkpoint(): OpenClawSessionCheckpointV1 {
    return {
      protocol: OPENCLAW_CHECKPOINT_CODEC,
      schemaVersion: OPENCLAW_CHECKPOINT_SCHEMA_VERSION,
      cwd: this.manager.getCwd(),
      entries: structuredClone(this.manager.getEntries()),
      leafId: this.manager.getLeafId(),
      canonicalTurnIds: [...this.canonicalTurnIds].sort(),
    };
  }
}
