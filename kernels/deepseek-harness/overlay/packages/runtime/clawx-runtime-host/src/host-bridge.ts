import { randomUUID } from 'node:crypto'
import { CLAWX_KERNEL_STDIO_PROTOCOL } from '@clawx/dsh-control-bridge'

type HostResponse = {
  protocol: typeof CLAWX_KERNEL_STDIO_PROTOCOL
  type: 'host-response'
  requestId: string
  kernelId: 'deepseek-harness'
  generation: number
  ok: boolean
  result?: unknown
  error?: { code?: string; message?: string }
}

type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: NodeJS.Timeout
}

export class ClawXRuntimeHostBridge {
  private readonly pending = new Map<string, Pending>()
  private closed = false

  constructor(
    private readonly identity: { kernelId: 'deepseek-harness'; generation: number },
    private readonly output: (message: unknown) => void,
    private readonly timeoutMs = 10_000,
  ) {}

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('ClawX host bridge is disconnected'))
    const requestId = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`ClawX host request timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(requestId, { resolve: value => { resolve(value as T) }, reject, timeout })
      this.output({
        protocol: CLAWX_KERNEL_STDIO_PROTOCOL,
        type: 'host-request',
        requestId,
        kernelId: this.identity.kernelId,
        generation: this.identity.generation,
        method,
        ...(params === undefined ? {} : { params }),
      })
    })
  }

  accept(value: unknown): boolean {
    if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'host-response') return false
    const response = value as HostResponse
    if (response.protocol !== CLAWX_KERNEL_STDIO_PROTOCOL
      || response.kernelId !== this.identity.kernelId
      || response.generation !== this.identity.generation
      || typeof response.requestId !== 'string'
      || typeof response.ok !== 'boolean') {
      throw new Error('Invalid or cross-generation ClawX host response')
    }
    const pending = this.pending.get(response.requestId)
    if (!pending) throw new Error('ClawX host response has an unknown request identity')
    clearTimeout(pending.timeout)
    this.pending.delete(response.requestId)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(new Error(response.error?.message ?? 'ClawX host request was denied'))
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const error = new Error('ClawX host bridge is disconnected')
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
