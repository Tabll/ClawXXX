import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-skill'

export type DshSkillCompatibility = {
  kernelId: string
  compatible: boolean
  mode: 'native' | 'converted' | 'patched' | 'unsupported'
  reason?: string
}

export type DshSkillProjection = {
  id: string
  slug: string
  displayName: string
  description: string
  version: string
  revision: number
  source: { kind: string; locator: string; digestSha256?: string }
  installedForKernels: string[]
  enabledForKernels: string[]
  compatibility: DshSkillCompatibility[]
  enabled: boolean
  instructionBody: string
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

type CatalogEntry = {
  projection: DshSkillProjection
  dispose?: () => void
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function validate(skill: DshSkillProjection): void {
  if (!skill.id?.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.slug ?? '')) {
    throw new Error('ClawX DSH Skill id and kebab-case slug are required')
  }
  if (!skill.displayName?.trim() || !skill.description?.trim() || !skill.instructionBody?.trim()) {
    throw new Error('ClawX DSH Skill name, description and instruction body are required')
  }
  if (!Number.isSafeInteger(skill.revision) || skill.revision < 1) {
    throw new Error('ClawX DSH Skill revision must be a positive safe integer')
  }
  if (!skill.installedForKernels.includes('deepseek-harness')) {
    throw new Error(`Skill ${skill.id} is not installed for DeepSeek Harness`)
  }
  const compatibility = skill.compatibility.find(entry => entry.kernelId === 'deepseek-harness')
  if (!compatibility?.compatible) {
    throw new Error(compatibility?.reason ?? `Skill ${skill.id} is incompatible with DeepSeek Harness`)
  }
}

/** Process-local only; ClawX SQLite remains the sole metadata authority. */
export default class ClawXDshSkillCatalog {
  private readonly entries = new Map<string, CatalogEntry>()
  private readonly operations = new Map<string, DshSkillProjection | true>()

  constructor(private readonly ctx: Context) {}

  list(): DshSkillProjection[] {
    return [...this.entries.values()].map(entry => clone(entry.projection))
  }

  upsert(entity: DshSkillProjection, operationId: string): DshSkillProjection {
    const replay = this.operations.get(operationId)
    if (replay && replay !== true) return clone(replay)
    validate(entity)
    const existing = this.entries.get(entity.id)
    if (existing && entity.revision < existing.projection.revision) {
      throw new Error(`Skill projection revision rollback refused: ${entity.revision} < ${existing.projection.revision}`)
    }
    existing?.dispose?.()
    let dispose: (() => void) | undefined
    try {
      if (entity.enabled) {
        dispose = this.ctx.skills.register({
          name: entity.slug,
          description: entity.description,
          source: 'clawx-canonical',
          provider: 'clawx-canonical',
          content: entity.instructionBody,
          metadata: {
            canonicalSkillId: entity.id,
            canonicalRevision: entity.revision,
            version: entity.version,
          },
        })
      }
      const stored = clone(entity)
      this.entries.set(stored.id, { projection: stored, ...(dispose ? { dispose } : {}) })
      this.operations.set(operationId, stored)
      return clone(stored)
    } catch (error) {
      this.entries.delete(entity.id)
      throw error
    }
  }

  remove(id: string, operationId: string): void {
    if (this.operations.has(operationId)) return
    const existing = this.entries.get(id)
    existing?.dispose?.()
    this.entries.delete(id)
    this.operations.set(operationId, true)
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.dispose?.()
    this.entries.clear()
  }
}
