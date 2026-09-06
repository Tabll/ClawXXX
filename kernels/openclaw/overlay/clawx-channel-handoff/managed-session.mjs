import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROTOCOL = 'clawx.openclaw-session/v1';
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;

/** Portable history is data, never executable native tool calls or configuration. */
export function canonicalHistoryMessages(blocks) {
  if (!Array.isArray(blocks) || blocks.length > 10_000
    || Buffer.byteLength(JSON.stringify(blocks)) > MAX_HISTORY_BYTES) throw new Error('Invalid canonical history budget');
  const turns = new Map();
  for (const block of blocks) {
    if (!block || typeof block.turnId !== 'string' || !['user', 'assistant', 'tool'].includes(block.role)
      || !Number.isInteger(block.position) || block.position < 0 || block.revoked
      || ['private', 'secret'].includes(block.visibility)
      || (block.kernelId && block.kernelId !== 'openclaw' && block.visibility !== 'portable')) {
      throw new Error('Canonical history contains a forbidden or untyped block');
    }
    const turn = turns.get(block.turnId) ?? { role: block.role, blocks: [] };
    if (turn.role !== block.role || turn.blocks.some(item => item.position === block.position)) {
      throw new Error('Canonical history turn identity is ambiguous');
    }
    turn.blocks.push(block);
    turns.set(block.turnId, turn);
  }
  return [...turns.values()].flatMap(turn => {
    const text = turn.blocks.sort((a, b) => a.position - b.position).map(block => {
      if (block.type === 'metadata') return '';
      if (typeof block.text === 'string') return block.text;
      if (block.type === 'tool-call' || block.type === 'tool-result') return `[Prior ${block.type}] ${JSON.stringify(block.json ?? {})}`;
      if (block.blobHash) return `[Prior attachment ${block.blobHash}; use the canonical attachment grant to access its contents]`;
      return '';
    }).filter(Boolean).join('\n');
    if (!text) return [];
    // Orphaned/cross-kernel tool results must not become executable tool frames.
    if (turn.role === 'user') return [{ role: 'user', content: text, timestamp: 0 }];
    return [{ role: 'assistant', content: [{ type: 'text', text }], timestamp: 0,
      api: 'openai-completions', provider: 'clawx-canonical-history', model: 'portable-context-v1', stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }];
  });
}

export function validateManagedSession(params) {
  const meta = params?.clawx;
  if (process.env.CLAWX_MANAGED_RUNTIME !== '1' || meta?.protocol !== PROTOCOL
    || !Number.isSafeInteger(meta.generation) || meta.generation < 1
    || !['conversationId', 'runId', 'turnId'].every(key => typeof meta[key] === 'string' && meta[key].length > 0 && meta[key].length <= 256)
    || !/^[a-z0-9][a-z0-9_-]*$/.test(meta.agentId ?? '')
    || typeof params.sessionId !== 'string') throw new Error('Invalid managed session admission');
  const digest = createHash('sha256').update(JSON.stringify([meta.conversationId, meta.runId, meta.generation])).digest('hex');
  if (params.sessionKey !== `agent:${meta.agentId}:dashboard:incognito-clawx-${digest}`
    || meta.history?.some(block => block.turnId === meta.turnId)) throw new Error('Managed session identity mismatch');
  return meta;
}

export function registerManagedSessionBridge(api) {
  if (process.env.CLAWX_MANAGED_RUNTIME !== '1') return;
  api.registerGatewayMethod('clawx.session.hydrate', async ({ params, respond }) => {
    try {
      const meta = validateManagedSession(params);
      const messages = canonicalHistoryMessages(meta.history);
      const packageDir = process.env.CLAWX_OPENCLAW_PACKAGE_DIR;
      if (!packageDir || !isAbsolute(packageDir)) throw new Error('Verified OpenClaw package root is required');
      const [{ getSessionEntry }, { SessionManager }] = await Promise.all([
        import(pathToFileURL(join(packageDir, 'dist/plugin-sdk/session-store-runtime.js')).href),
        import(pathToFileURL(join(packageDir, 'dist/plugin-sdk/agent-sessions.js')).href),
      ]);
      const target = { agentId: meta.agentId, sessionKey: params.sessionKey, sessionId: params.sessionId };
      const entry = getSessionEntry(target);
      if (!entry || entry.incognito !== true || entry.sessionId !== params.sessionId) throw new Error('Managed session is not incognito or has changed');
      const manager = SessionManager.open(target, params.cwd);
      if (manager.getEntries().length !== 0) throw new Error('Managed history can only hydrate a fresh session once');
      manager.appendCustomEntry(PROTOCOL, { runId: meta.runId, generation: meta.generation });
      for (const message of messages) manager.appendMessage(message);
      respond(true, { ok: true, protocol: PROTOCOL, messages: messages.length });
    } catch (error) {
      respond(false, undefined, { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : String(error) });
    }
  }, { scope: 'operator.admin' });
}
