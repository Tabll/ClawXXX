// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileManagedOpenClawSession, managedOpenClawSessionKey, openClawModelRef, openClawPermissionMode } from '@electron/kernels/openclaw/managed-session';
import { canonicalHistoryMessages, validateManagedSession } from '../../kernels/openclaw/overlay/clawx-channel-handoff/managed-session.mjs';
import type { KernelRunRequest } from '@shared/kernels/contracts';

function input(): KernelRunRequest {
  return { conversationId: 'conversation', runId: 'run', turnId: 'current', kernelId: 'openclaw', generation: 2, agentId: 'main', workspaceUri: 'file:///workspace', providerId: 'custom', modelId: 'model', permissionMode: 'ask', context: [
    { id: 'u1', turnId: 'previous-user', role: 'user', position: 0, type: 'text', text: 'past user', visibility: 'portable' },
    { id: 'a1', turnId: 'previous-answer', role: 'assistant', position: 0, type: 'text', text: 'past answer', visibility: 'portable', kernelId: 'deepseek-harness' },
    { id: 'u2', turnId: 'current', role: 'user', position: 0, type: 'text', text: 'current input', visibility: 'portable' },
  ] } as unknown as KernelRunRequest;
}

afterEach(() => vi.unstubAllEnvs());
describe('canonical-to-OpenClaw managed session protocol', () => {
  it('sends only the current turn as a prompt and retains historical roles from either kernel', () => {
    const compiled = compileManagedOpenClawSession(input());
    expect(compiled.prompt).toBe('current input');
    expect(compiled.managedSession).toMatchObject({ model: 'custom/model', permissionMode: 'guarded' });
    const messages = canonicalHistoryMessages(compiled.managedSession.history);
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0].content).toBe('past user');
    expect(messages[1].content).toEqual([{ type: 'text', text: 'past answer' }]);
  });

  it('fences each Run/generation/agent and validates the same identity at hydration', () => {
    vi.stubEnv('CLAWX_MANAGED_RUNTIME', '1');
    const request = input();
    const clawx = compileManagedOpenClawSession(request).managedSession;
    const params = { clawx, sessionKey: managedOpenClawSessionKey(request), sessionId: 'native-incognito' };
    expect(validateManagedSession(params)).toEqual(clawx);
    for (const override of [{ runId: 'next' }, { generation: 3 }, { agentId: 'work' }]) {
      expect(managedOpenClawSessionKey({ ...request, ...override } as KernelRunRequest)).not.toBe(params.sessionKey);
      expect(() => validateManagedSession({ ...params, clawx: { ...clawx, ...override } })).toThrow('identity');
    }
    expect(() => validateManagedSession({ ...params, clawx: { ...clawx, generation: 0 } })).toThrow('admission');
  });

  it('rejects private, revoked, ambiguous and untyped history and never replays a native tool operation', () => {
    const block = compileManagedOpenClawSession(input()).managedSession.history[0];
    for (const value of [{ ...block, visibility: 'secret' }, { ...block, revoked: true }, { ...block, role: undefined }, { ...block, kernelId: 'future-kernel', visibility: 'kernel' }]) {
      expect(() => canonicalHistoryMessages([value])).toThrow();
    }
    expect(() => canonicalHistoryMessages([block, block])).toThrow('ambiguous');
    const messages = canonicalHistoryMessages([{ ...block, role: 'tool', type: 'tool-result', text: undefined, json: { output: 'old output' } }]);
    expect(messages[0]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: expect.stringContaining('Prior tool-result') }] });
  });

  it('does not silently widen permission modes or invent a provider model', () => {
    expect(openClawPermissionMode('deny')).toBe('read-only');
    expect(openClawPermissionMode('ask')).toBe('guarded');
    expect(openClawPermissionMode('default')).toBe('workspace');
    expect(openClawModelRef('custom', 'custom/model')).toBe('custom/model');
    expect(() => openClawModelRef('custom')).toThrow('model');
    expect(() => compileManagedOpenClawSession({ ...input(), context: [] })).toThrow('missing');
  });
});
