import { describe, expect, it } from 'vitest';
import { projectOfficialDingTalkConfig } from '@electron/utils/dingtalk-plugin-compat';

describe('official DingTalk disposable projection', () => {
  it('preserves canonical community settings while adapting the strict official schema', () => {
    const original = { clientId: 'one', clientSecret: 'fixture', messageType: 'card', robotCode: 'old',
      groupPolicy: 'open', groups: { team: { groupAllowFrom: ['member'], requireMention: true, cardTemplateId: 'old' } } };
    expect(projectOfficialDingTalkConfig(original)).toEqual({ clientId: 'one', clientSecret: 'fixture',
      groupReplyMode: 'aicard', groupPolicy: 'open', requireMention: false,
      groups: { team: { allowFrom: ['member'], requireMention: true } } });
    expect(original.messageType).toBe('card');
    expect(original.groups.team.groupAllowFrom).toEqual(['member']);
  });
  it('keeps explicit official modes and group restrictions', () => {
    expect(projectOfficialDingTalkConfig({ messageType: 'card', groupReplyMode: 'text', groupPolicy: 'allowlist',
      requireMention: true, groupAllowFrom: ['allowed'], groups: { team: { allowFrom: ['official'], groupAllowFrom: ['old'] } },
      dwsAuthBundle: 'private',
    })).toEqual({ groupReplyMode: 'text', groupPolicy: 'allowlist', requireMention: true,
      groupAllowFrom: ['allowed'], groups: { team: { allowFrom: ['official'] } } });
  });
});
