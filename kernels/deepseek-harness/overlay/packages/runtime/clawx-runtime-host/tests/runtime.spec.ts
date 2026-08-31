import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClawXDshControlBridge } from '@clawx/dsh-control-bridge'
import type { ClawXDshPromptInput, ClawXDshPromptResult, ClawXRunIdentity, PermissionResolution } from '@clawx/dsh-acp-bridge'
import {
  ClawXDshRuntimeHost,
  DSH_RUNTIME_CAPABILITIES,
  createProductionRuntime,
  type RuntimeEngine,
} from '../src/index.ts'
import { acquireDshHomeLock, type DshHomeLock } from '../src/home-lock.ts'

class FakeEngine implements RuntimeEngine {
  readonly runs = new Set<string>()
  prompt(input: ClawXDshPromptInput): Promise<ClawXDshPromptResult> {
    return Promise.resolve({
      acceptedAt: new Date().toISOString(),
      nativeSessionId: input.identity.runId,
      checkpoint: {
        protocol: 'clawx.dsh-acp-bridge/v1',
        codec: 'deepseek-harness-agent',
        schemaVersion: 1,
        conversationId: input.identity.conversationId,
        agentId: input.agentId,
        workspaceUri: input.workspaceUri,
        contextHash: 'hash',
        nativeSessionId: input.identity.runId,
        completedAt: new Date().toISOString(),
      },
      outputAttachments: [],
    })
  }
  cancel(_identity: ClawXRunIdentity) { return Promise.resolve({ acknowledged: true }) }
  configure(_identity: ClawXRunIdentity, _params: Record<string, unknown>) { return Promise.resolve() }
  resolvePermission(_identity: ClawXRunIdentity, _resolution: PermissionResolution) { return Promise.resolve() }
  activeRunIds() { return [...this.runs] }
  close() { return Promise.resolve() }
}

describe('ClawX DSH runtime host', () => {
  let lock: DshHomeLock | undefined
  afterEach(async () => { await lock?.release(); lock = undefined })

  it('emits ready and generation-scoped responses using protocol-only envelopes', async () => {
    const output: unknown[] = []
    const control = new ClawXDshControlBridge({
      artifactVersion: '0.1.2-alpha.2+clawx.2',
      generation: 2,
      capabilities: DSH_RUNTIME_CAPABILITIES,
    })
    const host = new ClawXDshRuntimeHost({
      kernelId: 'deepseek-harness',
      generation: 2,
      artifactVersion: '0.1.2-alpha.2+clawx.2',
      dataDir: '/tmp/data',
      configDir: '/tmp/config',
      cacheDir: '/tmp/cache',
      selfTestEnabled: true,
    }, new FakeEngine(), control, value => { output.push(value) }, undefined, () => Promise.resolve({
      sandbox: {
        workspaceWrite: true,
        readOnlyDenied: true,
        windowsAmbientTempDenied: 'not-applicable',
        enforcement: 'full',
      },
      tools: { registered: ['read', 'write'], writeReadRoundTrip: true },
      permissions: { approvalPolicy: 'ask', orphanQuestionRejected: true },
    }))
    host.ready()
    await host.receive({
      protocol: 'clawx.kernel-stdio/v1',
      type: 'request',
      requestId: 'health',
      kernelId: 'deepseek-harness',
      generation: 2,
      method: 'runtime.health',
    })
    await host.receive({
      protocol: 'clawx.kernel-stdio/v1',
      type: 'request',
      requestId: 'new-session',
      kernelId: 'deepseek-harness',
      generation: 2,
      method: 'session.new',
      identity: { conversationId: 'conversation', turnId: 'turn', runId: 'run' },
    })
    await host.receive({
      protocol: 'clawx.kernel-stdio/v1',
      type: 'request',
      requestId: 'self-test',
      kernelId: 'deepseek-harness',
      generation: 2,
      method: 'runtime.selfTest',
    })
    expect(output).toEqual([
      expect.objectContaining({ type: 'ready', kernelId: 'deepseek-harness', generation: 2 }),
      expect.objectContaining({ type: 'response', requestId: 'health', ok: true }),
      expect.objectContaining({
        type: 'response',
        requestId: 'new-session',
        ok: true,
        result: expect.objectContaining({ nativeSessionId: null, durableState: 'clawx-data-service' }),
      }),
      expect.objectContaining({
        type: 'response',
        requestId: 'self-test',
        ok: true,
        result: expect.objectContaining({ tools: expect.objectContaining({ writeReadRoundTrip: true }) }),
      }),
    ])
    await host.close()
  })

  it('owns one home writer lock and recovers it after release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-dsh-lock-'))
    const path = join(root, 'runtime.lock')
    lock = await acquireDshHomeLock(path)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ pid: process.pid })
    await expect(acquireDshHomeLock(path)).rejects.toThrow(/already owned/)
    await lock.release()
    lock = await acquireDshHomeLock(path)
  })

  it('boots and disposes the production plugin world without native history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-dsh-production-'))
    const priorHome = process.env.DSH_HOME
    const output: unknown[] = []
    try {
      const { host } = await createProductionRuntime({
        config: {
          kernelId: 'deepseek-harness',
          generation: 4,
          artifactVersion: '0.1.2-alpha.2+clawx.2',
          capabilitiesDigest: 'a'.repeat(64),
          selfTestEnabled: true,
          dataDir: join(root, 'data'),
          configDir: join(root, 'config'),
          cacheDir: join(root, 'cache'),
        },
        output: value => { output.push(value) },
        diagnostic: () => undefined,
      })
      host.ready()
      expect(output).toContainEqual(expect.objectContaining({
        type: 'ready',
        generation: 4,
        capabilities: expect.objectContaining({ chat: true, checkpointCodecs: ['deepseek-harness-agent'] }),
      }))
      if (process.env.CLAWX_DSH_RUN_SANDBOX_SMOKE === '1') {
        await host.receive({
          protocol: 'clawx.kernel-stdio/v1',
          type: 'request',
          requestId: 'production-self-test',
          kernelId: 'deepseek-harness',
          generation: 4,
          method: 'runtime.selfTest',
        })
        expect(output).toContainEqual(expect.objectContaining({
          type: 'response',
          requestId: 'production-self-test',
          ok: true,
          result: expect.objectContaining({
            sandbox: expect.objectContaining({
              workspaceWrite: true,
              readOnlyDenied: true,
              windowsAmbientTempDenied: process.platform === 'win32' ? true : 'not-applicable',
            }),
            tools: expect.objectContaining({ writeReadRoundTrip: true }),
            permissions: { approvalPolicy: 'ask', orphanQuestionRejected: true },
          }),
        }))
      }
      await host.close()
      expect(await readFile(join(root, 'data', 'clawx-runtime.lock'), 'utf8').catch(() => undefined)).toBeUndefined()
    } finally {
      if (priorHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = priorHome
      await rm(root, { recursive: true, force: true })
    }
  })
})
