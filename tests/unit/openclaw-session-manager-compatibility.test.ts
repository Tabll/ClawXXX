// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assertInMemoryOpenClawSessionManager } from '@electron/kernels/openclaw/conversation-store-adapter';

describe('OpenClaw SessionManager persistence compatibility', () => {
  it('accepts the July file API and September target API only when detached', () => {
    expect(() => assertInMemoryOpenClawSessionManager({
      isPersisted: () => false,
      getSessionFile: () => undefined,
    })).not.toThrow();
    expect(() => assertInMemoryOpenClawSessionManager({
      isPersisted: () => false,
      getSessionTarget: () => undefined,
    })).not.toThrow();
  });

  it('rejects native persistence even if isPersisted disagrees with its target', () => {
    for (const manager of [
      { isPersisted: () => true, getSessionTarget: () => undefined },
      { isPersisted: () => false, getSessionTarget: () => ({ agentId: 'main', sessionId: 'native' }) },
      { isPersisted: () => false, getSessionFile: () => '/native/session.jsonl' },
      { isPersisted: () => false, getSessionTarget: () => null },
      { isPersisted: () => false, getSessionFile: () => undefined, getSessionTarget: () => ({}) },
    ]) expect(() => assertInMemoryOpenClawSessionManager(manager)).toThrow('strictly in-memory');
  });

  it('fails closed when a future release removes both known target probes', () => {
    expect(() => assertInMemoryOpenClawSessionManager({
      isPersisted: () => false,
    })).toThrow('strictly in-memory');
  });

  it('requires an explicit false persistence result from the runtime boundary', () => {
    for (const manager of [
      { getSessionTarget: () => undefined },
      { isPersisted: () => undefined, getSessionTarget: () => undefined },
      { isPersisted: () => null, getSessionTarget: () => undefined },
      { isPersisted: () => 0, getSessionTarget: () => undefined },
    ]) {
      expect(() => assertInMemoryOpenClawSessionManager(
        manager as unknown as Parameters<typeof assertInMemoryOpenClawSessionManager>[0],
      )).toThrow('strictly in-memory');
    }
  });
});
