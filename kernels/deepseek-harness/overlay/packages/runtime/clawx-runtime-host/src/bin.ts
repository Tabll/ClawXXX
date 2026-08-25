#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { createProductionRuntime, runtimeConfigFromEnvironment } from './index.ts'

const rawWrite = process.stdout.write.bind(process.stdout)
let protocolWriterInstalled = false

function writeProtocol(message: unknown): void {
  rawWrite(`${JSON.stringify(message)}\n`)
}

function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{8,}/gi, '[REDACTED]')
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => (
      /key|token|secret|credential/i.test(key) ? [key, '[REDACTED]'] : [key, redact(item)]
    )))
  }
  return value
}

function diagnostic(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    component: 'clawx-dsh-runtime',
    message: redact(message),
    ...(fields ? { fields: redact(fields) } : {}),
  })}\n`)
}

async function main(): Promise<void> {
  const config = runtimeConfigFromEnvironment()
  const { host } = await createProductionRuntime({ config, output: writeProtocol, diagnostic })
  // Capture the only legal writer first, then fail closed if a dependency or
  // future patch tries to print diagnostics to protocol stdout.
  if (!protocolWriterInstalled) {
    protocolWriterInstalled = true
    process.stdout.write = ((chunk: string | Uint8Array) => {
      diagnostic('error', 'Blocked non-protocol stdout write', { bytes: typeof chunk === 'string' ? chunk.length : chunk.byteLength })
      return true
    }) as typeof process.stdout.write
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
  let shuttingDown = false
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    diagnostic('info', 'Runtime shutdown requested', { reason })
    lines.close()
    process.stdin.pause()
    await host.close()
  }
  process.once('SIGTERM', () => { void shutdown('SIGTERM') })
  process.once('SIGINT', () => { void shutdown('SIGINT') })
  process.once('uncaughtException', (error) => {
    diagnostic('error', 'Uncaught runtime exception', { error: error.message })
    void shutdown('uncaughtException').finally(() => { process.exitCode = 1 })
  })
  process.once('unhandledRejection', (error) => {
    diagnostic('error', 'Unhandled runtime rejection', { error: error instanceof Error ? error.message : String(error) })
    void shutdown('unhandledRejection').finally(() => { process.exitCode = 1 })
  })
  lines.on('line', (line) => {
    if (line.length > 1_048_576) {
      diagnostic('error', 'Rejected oversized protocol request', { bytes: line.length })
      void shutdown('oversized-request').finally(() => { process.exitCode = 1 })
      return
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      diagnostic('error', 'Rejected non-JSON protocol request')
      void shutdown('invalid-json').finally(() => { process.exitCode = 1 })
      return
    }
    void host.receive(value).then(async () => {
      const input = value as { method?: unknown }
      if (input.method === 'runtime.shutdown') await shutdown('protocol')
    })
  })
  host.ready()
}

void main().catch((error: unknown) => {
  diagnostic('error', 'DeepSeek Harness runtime failed before ready', {
    error: error instanceof Error ? error.message : String(error),
  })
  process.exitCode = 1
})
