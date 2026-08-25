import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type PackageJson = {
  name?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

async function workspacePackages(): Promise<Map<string, PackageJson>> {
  const packages = new Map<string, PackageJson>()
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === 'lib') continue
      const child = join(directory, entry.name)
      const manifest = await readFile(join(child, 'package.json'), 'utf8').catch(() => undefined)
      if (manifest !== undefined) {
        const parsed = JSON.parse(manifest) as PackageJson
        if (parsed.name) packages.set(parsed.name, parsed)
      }
      await visit(child)
    }
  }
  await Promise.all(['vendor', 'packages', 'native'].map(root => visit(join(workspaceRoot, root))))
  return packages
}

describe('ClawX DSH production dependency closure', () => {
  it('provides every reachable workspace peer explicitly and excludes native history backends', async () => {
    const all = await workspacePackages()
    const host = all.get('@clawx/dsh-runtime-host')
    expect(host).toBeDefined()
    const provided = new Set(Object.keys(host!.dependencies ?? {}))
    const visited = new Set<string>()
    const queue = [...provided]
    const missingPeers = new Set<string>()
    while (queue.length > 0) {
      const name = queue.shift()!
      if (visited.has(name)) continue
      visited.add(name)
      const manifest = all.get(name)
      if (!manifest) continue
      for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
        if (all.has(peer) && !provided.has(peer)) missingPeers.add(peer)
        queue.push(peer)
      }
      for (const dependency of Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
      })) queue.push(dependency)
    }
    expect([...missingPeers].sort()).toEqual([])
    expect(provided.has('@deepseek-ai/dsh-session-persistence-jsonl')).toBe(false)
    expect(provided.has('@deepseek-ai/dsh-session-persistence-sqlite')).toBe(false)
    expect(provided.has('@deepseek-ai/dsh-settings-file')).toBe(false)
  })
})
