type Config = Record<string, unknown>;
const record = (value: unknown): Config | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Config : undefined;

/** Keep the existing host roster API while translating only at the native boundary. */
export function projectOpenClawConfigForHost(input: Config): Config {
  const config = structuredClone(input);
  const agents = record(config.agents);
  const entries = record(agents?.entries);
  if (!agents || !entries) return config;
  if (Array.isArray(agents.list)) throw new Error('OpenClaw config contains conflicting agent rosters');
  const systemAgent = record(record(agents.defaults)?.systemAgent)?.agentId;
  agents.list = Object.entries(entries).map(([id, entry]) => {
    if (!record(entry)) throw new Error(`Invalid OpenClaw agent entry: ${id}`);
    return { ...entry as Config, id, ...(systemAgent === id ? { default: true } : {}) };
  });
  // entries is intentionally retained as a format marker. The serializer uses
  // the mutated list, including deletions, never merges stale roster entries.
  return config;
}

export function projectOpenClawConfigForRuntime(input: Config, keyedRoster: boolean): Config {
  const config = structuredClone(input);
  const sourceAgents = record(config.agents);
  if (!keyedRoster && !record(sourceAgents?.entries)) return config;
  const agents = sourceAgents ?? {};
  const list = Array.isArray(agents.list) ? agents.list : Object.entries(record(agents.entries) ?? { main: {} }).map(([id, entry]) => ({ ...record(entry), id }));
  const entries: Config = {};
  const defaults = record(agents.defaults) ?? {};
  let selected: string | undefined;
  for (const value of list) {
    const entry = record(value);
    const id = entry?.id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(id) || Object.hasOwn(entries, id)) throw new Error('Invalid or duplicate OpenClaw agent identity');
    const { id: _id, default: isDefault, ...rest } = entry!;
    if (isDefault === true) {
      if (selected) throw new Error('Multiple default OpenClaw agents are not allowed');
      selected = id;
    }
    entries[id] = rest;
  }
  if (!Object.keys(entries).length) throw new Error('OpenClaw requires at least one canonical agent');
  const previousOwner = record(defaults.systemAgent)?.agentId;
  selected ??= typeof previousOwner === 'string' && Object.hasOwn(entries, previousOwner) ? previousOwner : undefined;
  selected ??= Object.hasOwn(entries, 'main') ? 'main' : Object.keys(entries)[0];
  defaults.systemAgent = { ...record(defaults.systemAgent), agentId: selected };
  agents.defaults = defaults;
  agents.entries = entries;
  agents.ownership = 'explicit';
  delete agents.list;
  config.agents = agents;
  if (keyedRoster) {
    // These are execution projections, not a second business-data authority.
    // New upstream defaults must not enable autonomous native schedules/runs.
    config.cron = { ...record(config.cron), enabled: false };
    config.logging = { ...record(config.logging), audit: { ...record(record(config.logging)?.audit), enabled: false, messages: 'off', executionIdentity: false } };
    defaults.heartbeat = { ...record(defaults.heartbeat), every: '0m' };
    const restrictTools = (value: unknown, global: boolean): Config => {
      const tools = record(value) ?? {};
      const deny = Array.isArray(tools.deny) ? tools.deny : [];
      tools.deny = [...new Set([...deny, 'cron', 'sessions_spawn', 'sessions_send', 'sessions_list', 'sessions_history', 'subagents'])];
      tools.swarm = false;
      const exec = record(tools.exec) ?? {};
      const execDenied = exec.mode === 'deny' || exec.security === 'deny';
      // Remove deprecated mutually exclusive fields; the per-run native
      // permission mode remains the upper bound, including read-only.
      delete exec.security;
      delete exec.ask;
      exec.mode = execDenied ? 'deny' : 'ask';
      // September session permission modes can supersede tools.exec policy.
      // Preserve an explicit legacy/native deny in the independent tool filter
      // too, so workspace/guarded sessions cannot re-enable command execution.
      if (execDenied) tools.deny = [...new Set([...tools.deny as unknown[], 'exec', 'process'])];
      tools.exec = exec;
      if (global) {
        tools.sessions = { ...record(tools.sessions), visibility: 'self' };
        tools.agentToAgent = { ...record(tools.agentToAgent), enabled: false };
        tools.elevated = { ...record(tools.elevated), enabled: false };
      }
      return tools;
    };
    config.tools = restrictTools(config.tools, true);
    for (const value of Object.values(entries)) {
      const agent = value as Config;
      agent.heartbeat = { ...record(agent.heartbeat), every: '0m' };
      agent.tools = restrictTools(agent.tools, false);
    }
    const plugins = record(config.plugins) ?? {};
    const pluginEntries = record(plugins.entries) ?? {};
    const memory = record(pluginEntries['memory-core']) ?? {};
    const memoryConfig = record(memory.config) ?? {};
    memoryConfig.dreaming = { ...record(memoryConfig.dreaming), enabled: false };
    memory.config = memoryConfig;
    pluginEntries['memory-core'] = memory;
    plugins.entries = pluginEntries;
    config.plugins = plugins;
  }
  return config;
}
