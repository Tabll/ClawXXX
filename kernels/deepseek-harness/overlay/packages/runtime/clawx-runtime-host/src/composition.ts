/** ClawX-owned execution services; no upstream app, history, credentials or scheduler. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as sessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as agentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as scopeInvariant from '@deepseek-ai/dsh-scope/invariant'
import * as agentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import * as llmRetry from '@deepseek-ai/dsh-llm-retry'
import * as bashEnv from '@deepseek-ai/dsh-shell-env'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import * as workspaceContext from '@deepseek-ai/dsh-agent-instructions'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs'

export const name = 'clawx-agent-services'

export interface Config {
  dataDir: string
  configDir: string
}

/** Mount the reviewed service set under the owning runtime fiber. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionTitle, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, includeRuntimeContext: true, persona: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, {
    dshHome: config.configDir,
    includeDefaultRoots: false,
    customSkillDirs: [join(config.dataDir, 'skills')],
    watchFollowSymlinks: false,
  })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(llmRetry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(sessionInvariant)
  await ctx.plugin(agentInvariant)
  await ctx.plugin(scopeInvariant)
  await ctx.plugin(agentLoopInvariant)
  await ctx.plugin(bashEnv, { dshHome: config.configDir })
  await ctx.plugin(toolBash)
  await ctx.plugin(workspaceContext, { maxBytes: 65_536 })
  await ctx.plugin(toolSkill)
  await ctx.plugin(toolJobs)
  await ctx.plugin(AgentLoop, { agents: [] })
}
