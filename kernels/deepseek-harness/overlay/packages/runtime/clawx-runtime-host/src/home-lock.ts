import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export type DshHomeLock = {
  path: string
  release(): Promise<void>
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Acquire the one-writer marker for a managed DSH home. Stale markers are
 * recovered only after their recorded PID is proven absent.
 */
export async function acquireDshHomeLock(path: string): Promise<DshHomeLock> {
  const lockPath = resolve(path)
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, startedAt: new Date().toISOString() })}\n`)
      await handle.sync()
      let released = false
      return {
        path: lockPath,
        async release() {
          if (released) return
          released = true
          await handle.close().catch(() => undefined)
          await unlink(lockPath).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          })
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let owner: number
      try {
        const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown }
        owner = typeof parsed.pid === 'number' ? parsed.pid : 0
      } catch {
        owner = 0
      }
      if (pidIsAlive(owner)) {
        throw new Error(`DeepSeek Harness home is already owned by PID ${owner}`, { cause: error })
      }
      await unlink(lockPath).catch((unlinkError: unknown) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
      })
    }
  }
  throw new Error('Unable to acquire DeepSeek Harness home writer lock')
}
