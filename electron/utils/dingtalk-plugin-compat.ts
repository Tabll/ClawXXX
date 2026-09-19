/** Translate only the disposable OpenClaw projection; retain canonical config. */
const ACCOUNT_FIELDS = new Set([
  'enabled', 'name', 'clientId', 'clientSecret', 'chatbotUserId', 'chatbotCorpId',
  'dmPolicy', 'allowFrom', 'groupPolicy', 'groupAllowFrom', 'requireMention', 'groups',
  'historyLimit', 'textChunkLimit', 'mediaMaxMb', 'tools', 'typingIndicator',
  'resolveSenderNames', 'separateSessionByConversation', 'sharedMemoryAcrossConversations',
  'groupSessionScope', 'asyncMode', 'ackText', 'endpoint', 'debug', 'enableMediaUpload',
  'systemPrompt', 'groupReplyMode',
]);
const GROUP_FIELDS = new Set(['requireMention', 'tools', 'enabled', 'allowFrom', 'systemPrompt', 'groupSessionScope']);

export function projectOfficialDingTalkConfig(input: Record<string, unknown>): Record<string, unknown> {
  const config = structuredClone(input);
  if (config.groupReplyMode == null) {
    if (config.messageType === 'card') config.groupReplyMode = 'aicard';
    else if (config.messageType === 'markdown' || config.messageType === 'text') config.groupReplyMode = config.messageType;
  }
  // Existing community accounts allowed unmentioned messages in open groups.
  if (config.requireMention == null && (config.groupPolicy == null || config.groupPolicy === 'open')) {
    config.requireMention = false;
  }
  if (config.groups && typeof config.groups === 'object' && !Array.isArray(config.groups)) {
    for (const group of Object.values(config.groups)) {
      if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
      if (group.allowFrom == null && Array.isArray(group.groupAllowFrom)) group.allowFrom = group.groupAllowFrom;
      for (const key of Object.keys(group)) if (!GROUP_FIELDS.has(key)) delete group[key];
    }
  }
  for (const key of Object.keys(config)) if (!ACCOUNT_FIELDS.has(key)) delete config[key];
  return config;
}
