import { randomUUID } from 'node:crypto'

export const CLAWX_DSH_CONTROL_PROTOCOL = 'clawx.dsh-control/v1' as const
export const CLAWX_DSH_CONTROL_PROTOCOL_VERSION = 1 as const
export const CLAWX_KERNEL_STDIO_PROTOCOL = 'clawx.kernel-stdio/v1' as const

export type ControlEntity = { id: string; [key: string]: unknown }

export type ControlBridgeCapabilities = {
  chat: boolean
  cancel: boolean
  permissions: boolean
  resume: boolean
  configuration: boolean
  agents: boolean
  providers: boolean
  skills: boolean
  channels: boolean
  cron: boolean
  usage: boolean
  checkpointCodecs: string[]
}

export type ControlBridgeIdentity = {
  kernelId: 'deepseek-harness'
  artifactVersion: string
  generation: number
  protocol: typeof CLAWX_DSH_CONTROL_PROTOCOL
  protocolVersion: typeof CLAWX_DSH_CONTROL_PROTOCOL_VERSION
  capabilitiesDigest?: string
}

export interface ControlEntityStore<T extends ControlEntity> {
  list(): Promise<T[]> | T[]
  upsert?(entity: T, operationId: string): Promise<T> | T
  remove?(id: string, operationId: string): Promise<void> | void
  setDefault?(id: string, operationId: string): Promise<void> | void
}

export interface ClawXDshControlBridgeOptions {
  artifactVersion: string
  generation: number
  capabilities: ControlBridgeCapabilities
  capabilitiesDigest?: string
  agents?: ControlEntityStore<ControlEntity>
  providers?: ControlEntityStore<ControlEntity>
  skills?: ControlEntityStore<ControlEntity>
  usage?: { query(input: unknown): Promise<unknown[]> | unknown[] }
  diagnostics?: () => Promise<Record<string, unknown>> | Record<string, unknown>
}

class MemoryEntityStore implements ControlEntityStore<ControlEntity> {
  private readonly entities = new Map<string, ControlEntity>()
  private defaultId: string | undefined

  constructor(seed: ControlEntity[] = []) {
    for (const entity of seed) this.entities.set(entity.id, structuredClone(entity))
  }

  list(): ControlEntity[] {
    return [...this.entities.values()].map(value => structuredClone(value))
  }

  upsert(entity: ControlEntity): ControlEntity {
    if (!entity.id) throw new Error('Control entity id is required')
    this.entities.set(entity.id, structuredClone(entity))
    return structuredClone(entity)
  }

  remove(id: string): void {
    if (!this.entities.delete(id)) throw new Error(`Control entity does not exist: ${id}`)
    if (this.defaultId === id) this.defaultId = undefined
  }

  setDefault(id: string): void {
    if (!this.entities.has(id)) throw new Error(`Control entity does not exist: ${id}`)
    this.defaultId = id
  }
}

export class ClawXDshControlBridge {
  readonly identity: ControlBridgeIdentity
  private defaultProvider?: { accountId: string; modelId?: string; operationId: string }
  private readonly stores: Record<'agents' | 'providers' | 'skills', ControlEntityStore<ControlEntity>>

  constructor(private readonly options: ClawXDshControlBridgeOptions) {
    if (!options.artifactVersion || !Number.isSafeInteger(options.generation) || options.generation < 1) {
      throw new Error('DeepSeek Harness control identity is incomplete')
    }
    assertMandatoryCapabilities(options.capabilities)
    this.identity = {
      kernelId: 'deepseek-harness',
      artifactVersion: options.artifactVersion,
      generation: options.generation,
      protocol: CLAWX_DSH_CONTROL_PROTOCOL,
      protocolVersion: CLAWX_DSH_CONTROL_PROTOCOL_VERSION,
      ...(options.capabilitiesDigest ? { capabilitiesDigest: options.capabilitiesDigest } : {}),
    }
    this.stores = {
      agents: options.agents ?? new MemoryEntityStore([{
        id: 'default',
        name: 'DeepSeek Harness',
        kernelId: 'deepseek-harness',
        isDefault: true,
      }]),
      providers: options.providers ?? new MemoryEntityStore([{
        id: 'deepseek-official',
        name: 'DeepSeek',
        kernelId: 'deepseek-harness',
      }]),
      skills: options.skills ?? new MemoryEntityStore(),
    }
  }

  initialize(input: {
    artifactVersion?: string
    generation?: number
    protocol?: string
    protocolVersion?: number
    capabilitiesDigest?: string
  } = {}): ControlBridgeIdentity {
    if (input.artifactVersion !== undefined && input.artifactVersion !== this.identity.artifactVersion) {
      throw new Error('DeepSeek Harness artifact identity mismatch')
    }
    if (input.generation !== undefined && input.generation !== this.identity.generation) {
      throw new Error('DeepSeek Harness generation mismatch')
    }
    if (input.protocol !== undefined && input.protocol !== CLAWX_DSH_CONTROL_PROTOCOL) {
      throw new Error('DeepSeek Harness control protocol mismatch')
    }
    if (input.protocolVersion !== undefined && input.protocolVersion !== CLAWX_DSH_CONTROL_PROTOCOL_VERSION) {
      throw new Error('DeepSeek Harness control protocol version mismatch')
    }
    if (input.capabilitiesDigest !== undefined
      && this.identity.capabilitiesDigest !== undefined
      && input.capabilitiesDigest !== this.identity.capabilitiesDigest) {
      throw new Error('DeepSeek Harness capability manifest identity mismatch')
    }
    return structuredClone(this.identity)
  }

  async dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === 'control.initialize' || method === 'initialize') {
      return this.initialize((params ?? {}) as Parameters<ClawXDshControlBridge['initialize']>[0])
    }
    if (method === 'control.health' || method === 'health') {
      return {
        status: 'ready',
        pid: process.pid,
        rssBytes: process.memoryUsage().rss,
        artifactVersion: this.identity.artifactVersion,
        generation: this.identity.generation,
      }
    }
    if (method === 'control.diagnostics' || method === 'diagnostics') {
      return {
        kernelId: this.identity.kernelId,
        artifactVersion: this.identity.artifactVersion,
        generation: this.identity.generation,
        nodeVersion: process.versions.node,
        moduleAbi: Number(process.versions.modules),
        protocol: this.identity.protocol,
        protocolVersion: this.identity.protocolVersion,
        conversationCatalog: 'clawx-data-service-only',
        nativeDurableHistory: false,
        ...(this.defaultProvider ? { defaultProvider: { ...this.defaultProvider } } : {}),
        ...await this.options.diagnostics?.(),
      }
    }
    if (method === 'control.usage.query') return await this.options.usage?.query(params) ?? []
    if (method === 'control.providers.default.set') {
      const input = (params ?? {}) as { accountId?: string; modelId?: string; operationId?: string }
      if (!input.accountId) throw new Error('Provider default account id is required')
      const providers = await this.stores.providers.list()
      if (!providers.some(provider => provider.id === input.accountId)) {
        throw new Error(`Provider account is not projected: ${input.accountId}`)
      }
      this.defaultProvider = {
        accountId: input.accountId,
        ...(input.modelId ? { modelId: input.modelId } : {}),
        operationId: input.operationId ?? randomUUID(),
      }
      return undefined
    }
    if (method === 'control.agents.default.set') {
      const input = (params ?? {}) as { agentId?: string; operationId?: string }
      if (!input.agentId) throw new Error('Agent default id is required')
      const store = this.stores.agents
      if (store.setDefault === undefined) throw new Error('Agent default selection is unsupported')
      await store.setDefault(input.agentId, input.operationId ?? randomUUID())
      return undefined
    }
    if (method === 'control.conversations.list' || method.startsWith('control.sessions.')) {
      throw new Error('Conversation catalog is owned exclusively by ClawX DataService')
    }
    const match = /^control\.(agents|providers|skills)\.(list|upsert|remove)$/.exec(method)
    if (match === null) throw new Error(`Unsupported DeepSeek Harness control method: ${method}`)
    const store = this.stores[match[1] as keyof typeof this.stores]
    if (match[2] === 'list') return await store.list()
    const input = (params ?? {}) as { entity?: ControlEntity; id?: string; operationId?: string }
    if (match[2] === 'upsert') {
      if (store.upsert === undefined || input.entity === undefined) throw new Error('Control upsert is unsupported or incomplete')
      return await store.upsert(input.entity, input.operationId ?? randomUUID())
    }
    if (store.remove === undefined || !input.id) throw new Error('Control remove is unsupported or incomplete')
    await store.remove(input.id, input.operationId ?? randomUUID())
    return undefined
  }
}

export function assertMandatoryCapabilities(capabilities: ControlBridgeCapabilities): void {
  const mandatory: Array<keyof ControlBridgeCapabilities> = [
    'chat',
    'cancel',
    'permissions',
    'resume',
    'configuration',
    'agents',
    'providers',
    'skills',
    'usage',
  ]
  const missing = mandatory.filter(key => capabilities[key] !== true)
  if (missing.length > 0 || !capabilities.checkpointCodecs.includes('deepseek-harness-agent')) {
    throw new Error(`DeepSeek Harness mandatory capabilities are missing: ${missing.join(', ') || 'checkpoint codec'}`)
  }
}

export function assertControlBridgeIdentity(input: {
  protocol: string
  protocolVersion: number
}): void {
  if (input.protocol !== CLAWX_DSH_CONTROL_PROTOCOL
    || input.protocolVersion !== CLAWX_DSH_CONTROL_PROTOCOL_VERSION) {
    throw new Error('DeepSeek Harness control bridge identity is incompatible')
  }
}
