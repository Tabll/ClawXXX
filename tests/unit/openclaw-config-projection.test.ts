// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { projectOpenClawConfigForHost as host, projectOpenClawConfigForRuntime as native } from '@electron/gateway/config-projection';

describe('September OpenClaw canonical config projection', () => {
  it('round-trips legacy host mutations without resurrecting a deleted keyed agent', () => {
    const snapshot = host({ agents: { ownership: 'explicit', defaults: { systemAgent: { agentId: 'work' } }, entries: { main: { workspace: '/main' }, work: { workspace: '/work' } } }, channels: { telegram: { tokenRef: 'secret-ref' } } });
    const roster = snapshot.agents as { list: Array<Record<string, unknown>> };
    expect(roster.list[1]).toMatchObject({ id: 'work', default: true });
    roster.list = [{ id: 'main', workspace: '/new', default: true }, { id: 'research', workspace: '/research' }];
    const projected = native(snapshot, true);
    expect(projected.agents).toMatchObject({ ownership: 'explicit', defaults: { systemAgent: { agentId: 'main' } }, entries: { main: { workspace: '/new' }, research: { workspace: '/research' } } });
    expect((projected.agents as Record<string, unknown>).list).toBeUndefined();
    expect((projected.agents as { entries: object }).entries).not.toHaveProperty('work');
    expect(projected.channels).toEqual(snapshot.channels);
    expect(native(host(projected), true)).toEqual(projected);
  });

  it('keeps July serialization unchanged and rejects ambiguous identities', () => {
    const old = { agents: { list: [{ id: 'main', default: true }] }, future: { keep: true } };
    expect(native(old, false)).toEqual(old);
    expect(() => host({ agents: { list: [], entries: {} } })).toThrow('conflicting');
    for (const list of [[], [{ id: '../bad' }], [{ id: 'main' }, { id: 'main' }], [{ id: 'main', default: true }, { id: 'work', default: true }]]) {
      expect(() => native({ agents: { list } }, true)).toThrow();
    }
  });

  it('bounds new native defaults while preserving providers, credentials and unknown fields', () => {
    const original = { models: { providers: { custom: { apiKey: 'test-only', baseUrl: 'http://localhost' } } }, agents: { list: [{ id: 'main', heartbeat: { every: '1m' }, tools: { swarm: true } }] }, tools: { exec: { security: 'full', ask: 'off', host: 'gateway' }, agentToAgent: { enabled: true }, sessions: { visibility: 'all' }, deny: ['custom-tool'] }, cron: { enabled: true }, future: 7 };
    const projected = native(original, true);
    expect(projected.models).toEqual(original.models);
    expect(projected.future).toBe(7);
    expect(projected.cron).toMatchObject({ enabled: false });
    expect(projected.tools).toMatchObject({ swarm: false, exec: { mode: 'ask', host: 'gateway' }, sessions: { visibility: 'self' }, agentToAgent: { enabled: false }, elevated: { enabled: false }, deny: expect.arrayContaining(['custom-tool', 'cron', 'sessions_spawn']) });
    expect((projected.tools as { exec: object }).exec).not.toHaveProperty('security');
    expect(projected.agents).toMatchObject({ defaults: { heartbeat: { every: '0m' } }, entries: { main: { heartbeat: { every: '0m' }, tools: { swarm: false } } } });
    expect(original.cron.enabled).toBe(true);
  });

  it('preserves hard exec denial independently of per-session permission modes', () => {
    for (const exec of [{ security: 'deny', ask: 'off' }, { mode: 'deny' }]) {
      const original = { tools: { exec }, agents: { list: [{ id: 'main' }, { id: 'locked', tools: { exec } }] } };
      const projected = native(original, true);
      expect(projected.tools).toMatchObject({ exec: { mode: 'deny' }, deny: expect.arrayContaining(['exec', 'process']) });
      expect(projected.agents).toMatchObject({ entries: { locked: { tools: { exec: { mode: 'deny' }, deny: expect.arrayContaining(['exec', 'process']) } } } });
      expect(native(host(projected), true)).toEqual(projected);
      expect(original.tools.exec).toEqual(exec);
    }
  });
});
