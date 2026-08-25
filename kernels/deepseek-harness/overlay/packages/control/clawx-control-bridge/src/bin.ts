#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { ClawXDshControlBridge, type ControlBridgeCapabilities } from './index.ts'

const artifactVersion = process.env.CLAWX_KERNEL_ARTIFACT_VERSION ?? 'development'
const generation = Number(process.env.CLAWX_KERNEL_GENERATION ?? '1')
const capabilitiesDigest = process.env.CLAWX_KERNEL_CAPABILITIES_DIGEST
const capabilities: ControlBridgeCapabilities = {
  chat: true,
  cancel: true,
  permissions: true,
  resume: true,
  configuration: true,
  agents: true,
  providers: true,
  skills: true,
  channels: false,
  cron: false,
  usage: true,
  checkpointCodecs: ['deepseek-harness-agent'],
}
const bridge = new ClawXDshControlBridge({
  artifactVersion,
  generation,
  capabilities,
  ...(capabilitiesDigest ? { capabilitiesDigest } : {}),
})
const output = process.stdout.write.bind(process.stdout)
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
let closing = false
let requestTail = Promise.resolve()

function write(value: unknown): void {
  output(`${JSON.stringify(value)}\n`)
}

lines.on('line', (line) => {
  requestTail = requestTail.then(async () => {
    let input: { id?: unknown; method?: unknown; params?: unknown } | undefined
    try {
      input = JSON.parse(line) as typeof input
      if (!input || typeof input.id !== 'string' || typeof input.method !== 'string') throw new Error('Invalid control request')
      if (input.method === 'shutdown') {
        closing = true
        write({ protocol: 'clawx.kernel/v1', id: input.id, ok: true, result: { accepted: true } })
        lines.close()
        process.stdin.pause()
        setImmediate(() => process.exit(0))
        return
      }
      const result = await bridge.dispatch(input.method, input.params)
      write({ protocol: 'clawx.kernel/v1', id: input.id, ok: true, result })
    } catch (error) {
      const id = typeof input?.id === 'string' ? input.id : 'invalid'
      write({
        protocol: 'clawx.kernel/v1',
        id,
        ok: false,
        error: { code: 'CONTROL_ERROR', message: error instanceof Error ? error.message : String(error) },
      })
    }
  })
})

lines.on('close', () => {
  if (!closing) process.exitCode = 0
})
