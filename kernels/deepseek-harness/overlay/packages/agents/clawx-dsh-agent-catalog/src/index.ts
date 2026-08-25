export type DshAgentModel = {
  providerAccountId?: string
  providerId: string
  modelId: string
  parameters?: Record<string, string | number | boolean>
}

export type DshAgentProjection = {
  id: string
  displayName: string
  description?: string
  persona?: string
  presetId?: string
  workspaceUri: string
  model?: DshAgentModel
  enabled: boolean
  supportedKernels: string[]
  version: number
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

export type DshAgentRunComposition = Readonly<{
  id: string
  displayName: string
  workspaceUri: string
  persona?: string
  presetId?: string
  model?: DshAgentModel
  version: number
}>

function clone<T>(value: T): T {
  return structuredClone(value)
}

function validate(agent: DshAgentProjection): void {
  if (!agent.id?.trim() || !agent.displayName?.trim() || !agent.workspaceUri?.trim()) {
    throw new Error('ClawX DSH Agent identity, display name and workspace URI are required')
  }
  if (!Number.isSafeInteger(agent.version) || agent.version < 1) {
    throw new Error('ClawX DSH Agent version must be a positive safe integer')
  }
  if (!agent.supportedKernels.includes('deepseek-harness')) {
    throw new Error(`Agent ${agent.id} does not support DeepSeek Harness`)
  }
  const workspace = new URL(agent.workspaceUri)
  if (workspace.protocol !== 'file:') throw new Error('DeepSeek Harness Agent workspace must use a file URI')
}

/** Process-local projection only; ClawX SQLite remains the sole authority. */
export default class ClawXDshAgentCatalog {
  private readonly agents = new Map<string, DshAgentProjection>()
  private readonly operations = new Map<string, unknown>()
  private defaultId: string | undefined

  list(): DshAgentProjection[] {
    return [...this.agents.values()].map(agent => clone({
      ...agent,
      isDefault: agent.id === this.defaultId,
    }))
  }

  upsert(entity: DshAgentProjection, operationId: string): DshAgentProjection {
    const replay = this.operations.get(operationId)
    if (replay !== undefined) return clone(replay as DshAgentProjection)
    validate(entity)
    const existing = this.agents.get(entity.id)
    if (existing && entity.version < existing.version) {
      throw new Error(`Agent projection version rollback refused: ${entity.version} < ${existing.version}`)
    }
    const stored = clone(entity)
    this.agents.set(stored.id, stored)
    this.operations.set(operationId, stored)
    return clone(stored)
  }

  remove(id: string, operationId: string): void {
    if (this.operations.has(operationId)) return
    if (!this.agents.delete(id)) throw new Error(`Agent projection does not exist: ${id}`)
    if (this.defaultId === id) this.defaultId = undefined
    this.operations.set(operationId, true)
  }

  setDefault(id: string, operationId: string): void {
    if (this.operations.has(operationId)) return
    if (!this.agents.has(id)) throw new Error(`Agent projection does not exist: ${id}`)
    this.defaultId = id
    this.operations.set(operationId, true)
  }

  resolveForRun(input: {
    agentId?: string
    canonicalVersion?: number
    workspaceUri?: string
  }): DshAgentRunComposition {
    const id = input.agentId ?? this.defaultId
    if (!id) throw new Error('No DeepSeek Harness Agent was selected and no default is projected')
    const agent = this.agents.get(id)
    if (!agent || !agent.enabled) throw new Error(`DeepSeek Harness Agent is unavailable: ${id}`)
    if (input.canonicalVersion !== undefined && input.canonicalVersion !== agent.version) {
      throw new Error(`Agent projection version mismatch: expected ${agent.version}, received ${input.canonicalVersion}`)
    }
    if (input.workspaceUri !== undefined && input.workspaceUri !== agent.workspaceUri) {
      throw new Error('Agent projection workspace does not match the admitted run snapshot')
    }
    return Object.freeze(clone({
      id: agent.id,
      displayName: agent.displayName,
      workspaceUri: agent.workspaceUri,
      ...(agent.persona ? { persona: agent.persona } : {}),
      ...(agent.presetId ? { presetId: agent.presetId } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      version: agent.version,
    }))
  }
}
