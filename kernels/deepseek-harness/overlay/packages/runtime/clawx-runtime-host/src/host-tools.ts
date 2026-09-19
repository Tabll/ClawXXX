import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ClawXDshAcpBridge } from '@clawx/dsh-acp-bridge'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export function registerHostTools(ctx: Context, bridge: ClawXDshAcpBridge): void {
  const descriptions = {
    clawx_dingtalk: 'Authorized DingTalk workspace. args: {action:"list"} or {action:"execute",accountId,args:[...DWS CLI arguments]}. Explicit account and user approval required. Do not use auth/config/plugin commands.',
    clawx_agent: 'Canonical independent child agents with inherited Agent/workspace/model/permissions. args: {action:"spawn",prompt} or {action:"list"} or {action:"status"|"wait"|"cancel",runId,timeoutMs?}. Maximum depth 3 and 8 children per Run. Child history and usage are stored by ClawX.',
    clawx_computer: 'Explicitly enabled ClawX Computer Use. args: {action:"list"} returns allowed schemas; {action:"call",name,parameters:{...}} performs one approved action. Omit session; Main owns it. Never start another daemon or request OS permissions through shell commands.',
  }
  for (const [name, description] of Object.entries(descriptions)) {
    ctx.tools.register(defineTool({
      name, description, parameters: { args: { type: 'json', required: true } },
      output: { schema: { type: 'json' }, render: (_args, value) => (value as unknown as { content: ContentBlock[] }).content },
      execute: async (input, exec) => {
        const grant = exec.agent ? bridge.hostToolGrant(exec.agent.session.id) : undefined
        if (!grant) throw new Error('ClawX host tool requires an admitted Run')
        const url = new URL(grant.url)
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/v1/run/tool'
          || url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9_-]{43}$/.test(grant.token)) throw new Error('Invalid host grant')
        const response = await fetch(url, { method: 'POST', redirect: 'error', signal: exec.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grant.token}` },
          body: JSON.stringify({ tool: name, args: input.args }) })
        if (!response.ok) throw new Error('ClawX host tool failed or permission denied')
        const { result } = await response.json() as { result: unknown }
        if (name === 'clawx_computer' && result && typeof result === 'object' && 'content' in result) {
          const content: ContentBlock[] = []
          for (const part of (result as { content: Array<{ type: string; text?: string; mimeType?: string; data?: string }> }).content) {
            if (part.type === 'text' && part.text) content.push({ type: 'text', text: part.text })
            if (part.type === 'image' && part.data && part.mimeType) {
              const attachment = await ctx.attachments.saveImage({ data: Buffer.from(part.data, 'base64'), mediaType: part.mimeType as ImageMediaType })
              content.push({ type: 'image', attachment })
            }
          }
          return { content } as unknown as JsonValue
        }
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] }
      },
    }))
  }
}
