const grants = new Map();
const descriptions = {
  clawx_dingtalk: 'Use an authorized DingTalk workspace through ClawX. args: {action:"list"} lists accounts for this Run; {action:"execute",accountId,args:[...DWS CLI arguments]} executes with that explicit account after user approval. Never use auth/config/plugin commands or shell commands.',
  clawx_agent: 'Delegate work to an independent canonical child Conversation using the same Agent, workspace, model and permissions. args: {action:"spawn",prompt} or {action:"list"} or {action:"status"|"wait"|"cancel",runId,timeoutMs?}. Maximum nesting 3, maximum 8 children per Run. Child output and usage are stored independently. Use this instead of native session spawning/history.',
  clawx_computer: 'Use explicitly enabled ClawX Computer Use. args: {action:"list"} returns allowed native tool schemas; {action:"call",name,parameters:{...}} performs one action after user approval. Omit session; Main owns it. If unavailable report it; never start a daemon or request OS permissions through a shell.',
};

export function rememberHostTools(sessionKey, grant) {
  if (!grant) return;
  const url = new URL(grant.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/v1/run/tool'
    || url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9_-]{43}$/.test(grant.token)) throw new Error('Invalid host tool grant');
  grants.set(sessionKey, { ...grant, expiresAt: Date.now() + 24 * 60 * 60_000 });
  for (const [key, entry] of grants) if (entry.expiresAt <= Date.now()) grants.delete(key);
  while (grants.size > 1024) grants.delete(grants.keys().next().value);
}

export function registerHostTools(api) {
  for (const [name, description] of Object.entries(descriptions)) {
    api.registerTool(context => {
      const grant = grants.get(context.sessionKey);
      if (!grant || grant.expiresAt <= Date.now()) return null;
      return { name, label: name, description,
        parameters: { type: 'object', required: ['args'], properties: { args: { type: 'object', additionalProperties: true } }, additionalProperties: false },
        async execute(_id, input, signal) {
          const response = await fetch(grant.url, { method: 'POST', redirect: 'error',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grant.token}` },
            body: JSON.stringify({ tool: name, args: input.args }), signal });
          if (!response.ok) throw new Error('ClawX host tool failed or permission denied');
          const { result } = await response.json();
          if (name === 'clawx_computer' && result && Array.isArray(result.content)) return result;
          return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
        },
      };
    }, { name });
  }
  api.on('before_tool_call', (event, context) => {
    if (grants.has(context.sessionKey) && ['sessions_spawn', 'sessions_send', 'sessions_history', 'sessions_list'].includes(event.toolName)) {
      return { block: true, blockReason: 'Managed ClawX conversations use clawx_agent and canonical history.' };
    }
  });
}
