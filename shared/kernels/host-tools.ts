/** Private execution metadata. Never persist in canonical content or expose to Renderer/model. */
export type HostToolGrant = { url: string; token: string };
export type HostToolName = 'clawx_dingtalk' | 'clawx_agent' | 'clawx_computer';
export type HostToolRequest = { tool: HostToolName; args: Record<string, unknown> };
