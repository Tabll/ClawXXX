import { spawn } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import BashSandbox from '@deepseek-ai/dsh-bash-sandbox'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import FsSandbox from '@deepseek-ai/dsh-fs-sandbox'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import ClawXDshCredentialProvider from '@clawx/dsh-credential-provider'
import ClawXDshAgentCatalog from '@clawx/dsh-agent-catalog'
import ClawXDshSkillCatalog from '@clawx/dsh-skill-catalog'
import {
  CLAWX_DSH_ACP_BRIDGE_PROTOCOL,
  CLAWX_DSH_CHECKPOINT_CODEC,
  CLAWX_DSH_CHECKPOINT_SCHEMA_VERSION,
  ClawXDshAcpBridge,
  assertClawXDshBridgeIdentity,
  type ClawXDshKernelEvent,
  type ClawXDshPromptInput,
  type ClawXDshPromptResult,
  type ClawXRunIdentity,
  type PermissionResolution,
} from '@clawx/dsh-acp-bridge'
import {
  CLAWX_DSH_CONTROL_PROTOCOL,
  CLAWX_DSH_CONTROL_PROTOCOL_VERSION,
  CLAWX_KERNEL_STDIO_PROTOCOL,
  ClawXDshControlBridge,
  assertControlBridgeIdentity,
  type ControlBridgeCapabilities,
} from '@clawx/dsh-control-bridge'
import { acquireDshHomeLock, type DshHomeLock } from './home-lock.ts'
import { ClawXRuntimeHostBridge } from './host-bridge.ts'
import { SANDBOX_WRITE_PROBE, sandboxWriteWasDenied } from './sandbox-probe.ts'
import * as ClawXAgentServices from './composition.ts'

export const DSH_RUNTIME_HOST_PROTOCOL = CLAWX_KERNEL_STDIO_PROTOCOL
export const DSH_RUNTIME_KERNEL_ID = 'deepseek-harness' as const

export type RuntimeRequestIdentity = ClawXRunIdentity

export type RuntimeRequest = {
  protocol: typeof CLAWX_KERNEL_STDIO_PROTOCOL
  type: 'request'
  requestId: string
  kernelId: typeof DSH_RUNTIME_KERNEL_ID
  generation: number
  method: string
  identity?: RuntimeRequestIdentity
  params?: unknown
}

export type RuntimeHostConfig = {
  kernelId: typeof DSH_RUNTIME_KERNEL_ID
  generation: number
  artifactVersion: string
  dataDir: string
  configDir: string
  cacheDir: string
  capabilitiesDigest?: string
  /** Enables the destructive, CI-only runtime self-test RPC. */
  selfTestEnabled?: boolean
}

export type RuntimeSelfTestResult = {
  sandbox: {
    workspaceWrite: true
    readOnlyDenied: true
    windowsAmbientTempDenied: true | 'not-applicable'
    enforcement: 'full' | 'partial'
  }
  tools: {
    registered: string[]
    writeReadRoundTrip: true
  }
  permissions: {
    approvalPolicy: 'ask'
    orphanQuestionRejected: true
  }
}

export interface RuntimeEngine {
  prompt(input: ClawXDshPromptInput): Promise<ClawXDshPromptResult>
  cancel(identity: ClawXRunIdentity): Promise<{ acknowledged: boolean }>
  configure(identity: ClawXRunIdentity, params: Record<string, unknown>): Promise<void>
  resolvePermission(identity: ClawXRunIdentity, resolution: PermissionResolution): Promise<void>
  activeRunIds(): string[]
  close(): Promise<void>
}

export type RuntimeOutput = (message: unknown) => void

export const DSH_RUNTIME_CAPABILITIES: ControlBridgeCapabilities = Object.freeze({
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
  checkpointCodecs: [CLAWX_DSH_CHECKPOINT_CODEC],
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isExpectedOrphanQuestionDenial(error: unknown): boolean {
  const message = errorMessage(error)
  return /Question belongs to no active ClawX run/i.test(message)
    || (message.includes('"user-questions/request" is a scope-filtered event')
      && message.includes('dispatched without a scope carrier'))
}

async function readUtf8OrUndefined(path: string): Promise<string | undefined> {
  return await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
}

async function runConfined(
  ctx: Context,
  argv: string[],
  workspaceRoot: string,
  mode: 'read-only' | 'workspace-write',
): Promise<{
    status: number | null
    stderr: string
    enforcement: 'full' | 'partial'
  }> {
  const confined = ctx.sandbox.confine(argv, { mode, workspaceRoot })
  return await new Promise((accept, reject) => {
    const child = spawn(confined.argv[0]!, confined.argv.slice(1), {
      cwd: workspaceRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    let settled = false
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384) })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      if (!settled) {
        settled = true
        reject(new Error(`DeepSeek Harness ${mode} sandbox probe timed out`))
      }
    }, 30_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    child.once('close', (status) => {
      clearTimeout(timeout)
      if (!settled) {
        settled = true
        accept({ status, stderr, enforcement: confined.enforcement })
      }
    })
  })
}

async function runProductionSelfTest(ctx: Context, config: RuntimeHostConfig): Promise<RuntimeSelfTestResult> {
  const root = join(config.dataDir, 'runtime-self-test')
  const allowedPath = join(root, 'sandbox-workspace-write.txt')
  const deniedPath = join(root, 'sandbox-read-only.txt')
  const toolPath = join(root, 'tool-round-trip.txt')
  const ambientTempPath = join(tmpdir(), `clawx-dsh-ambient-temp-${process.pid}-${Date.now()}.txt`)
  const writeScript = SANDBOX_WRITE_PROBE
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true, mode: 0o700 })
  try {
    const allowed = await runConfined(ctx, [process.execPath, '-e', writeScript, allowedPath], root, 'workspace-write')
    if (allowed.status !== 0 || await readUtf8OrUndefined(allowedPath) !== 'sandbox-ok') {
      throw new Error(`DeepSeek Harness workspace-write sandbox probe failed: ${allowed.stderr}`)
    }
    const denied = await runConfined(ctx, [process.execPath, '-e', writeScript, deniedPath], root, 'read-only')
    if (!sandboxWriteWasDenied(denied, deniedPath)
      || await readUtf8OrUndefined(deniedPath) !== undefined) {
      throw new Error(`DeepSeek Harness read-only sandbox did not fail closed: ${denied.stderr}`)
    }

    let windowsAmbientTempDenied: true | 'not-applicable' = 'not-applicable'
    if (process.platform === 'win32') {
      const ambientShell = await runConfined(
        ctx,
        [process.execPath, '-e', writeScript, ambientTempPath],
        root,
        'workspace-write',
      )
      if (!sandboxWriteWasDenied(ambientShell, ambientTempPath)
        || await readUtf8OrUndefined(ambientTempPath) !== undefined) {
        throw new Error(`DeepSeek Harness Windows shell wrote the ambient temp root: ${ambientShell.stderr}`)
      }
    }

    const registered = ctx.tools.schemas().map(schema => schema.name).sort()
    const requiredTools = ['ask_user_question', 'edit', 'read', 'read_image', 'todo_write', 'write']
    const missingTools = requiredTools.filter(name => !registered.includes(name))
    if (missingTools.length > 0) throw new Error(`DeepSeek Harness runtime tools are missing: ${missingTools.join(', ')}`)
    const signal = new AbortController().signal
    const write = await ctx.tools.execute({
      callId: ToolCallId('clawx-runtime-self-test-write'),
      name: 'write',
      arguments: { file_path: toolPath, content: 'tool-ok' },
      signal,
    })
    if (write.isError) throw new Error(`DeepSeek Harness write tool smoke failed: ${write.error.message}`)
    const read = await ctx.tools.execute({
      callId: ToolCallId('clawx-runtime-self-test-read'),
      name: 'read',
      arguments: { file_path: toolPath },
      signal,
    })
    if (read.isError || await readUtf8OrUndefined(toolPath) !== 'tool-ok') {
      throw new Error(`DeepSeek Harness read tool smoke failed${read.isError ? `: ${read.error.message}` : ''}`)
    }
    if (process.platform === 'win32') {
      const ambientTool = await ctx.tools.execute({
        callId: ToolCallId('clawx-runtime-self-test-ambient-temp-write'),
        name: 'write',
        arguments: { file_path: ambientTempPath, content: 'must-not-exist' },
        signal,
      })
      const ambientToolError = ambientTool.isError ? ambientTool.error.message.toLowerCase() : ''
      if (!ambientTool.isError
        || await readUtf8OrUndefined(ambientTempPath) !== undefined
        || !ambientToolError.includes('[sandbox:')) {
        throw new Error(`DeepSeek Harness file tool wrote the Windows ambient temp root: ${ambientToolError}`)
      }
      windowsAmbientTempDenied = true
    }

    if (ctx.approval.config.policy !== 'ask') throw new Error('DeepSeek Harness approval policy is not interactive')
    let orphanQuestionRejected = false
    try {
      await ctx.userQuestions.ask({
        questions: [{ id: 'runtime-self-test', question: 'Self-test question', options: [{ label: 'Continue' }] }],
      })
    } catch (error) {
      orphanQuestionRejected = isExpectedOrphanQuestionDenial(error)
    }
    if (!orphanQuestionRejected) throw new Error('DeepSeek Harness orphan ask-user request did not fail closed')

    return {
      sandbox: {
        workspaceWrite: true,
        readOnlyDenied: true,
        windowsAmbientTempDenied,
        enforcement: allowed.enforcement === 'partial' || denied.enforcement === 'partial' ? 'partial' : 'full',
      },
      tools: { registered, writeReadRoundTrip: true },
      permissions: { approvalPolicy: 'ask', orphanQuestionRejected: true },
    }
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(ambientTempPath, { force: true }),
    ])
  }
}

function requireIdentity(request: RuntimeRequest): RuntimeRequestIdentity {
  const identity = request.identity
  if (identity === undefined
    || !identity.conversationId
    || !identity.turnId
    || !identity.runId) throw new Error(`${request.method} requires a complete run identity`)
  return identity
}

function isRuntimeRequest(value: unknown, config: RuntimeHostConfig): value is RuntimeRequest {
  if (typeof value !== 'object' || value === null) return false
  const input = value as Record<string, unknown>
  return input.protocol === CLAWX_KERNEL_STDIO_PROTOCOL
    && input.type === 'request'
    && typeof input.requestId === 'string'
    && input.kernelId === config.kernelId
    && input.generation === config.generation
    && typeof input.method === 'string'
}

export class ClawXDshRuntimeHost {
  private closing = false
  private startedAt = performance.now()

  constructor(
    readonly config: RuntimeHostConfig,
    private readonly engine: RuntimeEngine,
    private readonly control: ClawXDshControlBridge,
    private readonly output: RuntimeOutput,
    private readonly disposeWorld: () => Promise<void> = () => Promise.resolve(),
    private readonly selfTest?: () => Promise<RuntimeSelfTestResult>,
    private readonly hostBridge?: ClawXRuntimeHostBridge,
  ) {
    if (config.kernelId !== DSH_RUNTIME_KERNEL_ID
      || !Number.isSafeInteger(config.generation)
      || config.generation < 1
      || !config.artifactVersion) throw new Error('DeepSeek Harness runtime identity is incomplete')
    assertClawXDshBridgeIdentity({
      protocol: CLAWX_DSH_ACP_BRIDGE_PROTOCOL,
      checkpointCodec: CLAWX_DSH_CHECKPOINT_CODEC,
      checkpointSchemaVersion: CLAWX_DSH_CHECKPOINT_SCHEMA_VERSION,
    })
    assertControlBridgeIdentity({
      protocol: CLAWX_DSH_CONTROL_PROTOCOL,
      protocolVersion: CLAWX_DSH_CONTROL_PROTOCOL_VERSION,
    })
    control.initialize({
      artifactVersion: config.artifactVersion,
      generation: config.generation,
      protocol: CLAWX_DSH_CONTROL_PROTOCOL,
      protocolVersion: CLAWX_DSH_CONTROL_PROTOCOL_VERSION,
      ...(config.capabilitiesDigest ? { capabilitiesDigest: config.capabilitiesDigest } : {}),
    })
  }

  ready(): void {
    this.output({
      protocol: CLAWX_KERNEL_STDIO_PROTOCOL,
      type: 'ready',
      kernelId: this.config.kernelId,
      generation: this.config.generation,
      pid: process.pid,
      version: this.config.artifactVersion,
      capabilities: DSH_RUNTIME_CAPABILITIES,
      startupDurationMs: Math.ceil(performance.now() - this.startedAt),
      rssBytes: process.memoryUsage().rss,
    })
  }

  async receive(value: unknown): Promise<void> {
    if (this.hostBridge?.accept(value)) return
    if (!isRuntimeRequest(value, this.config)) {
      throw new Error('Invalid or cross-generation DeepSeek Harness runtime request')
    }
    try {
      const result = await this.dispatch(value)
      this.output({
        protocol: CLAWX_KERNEL_STDIO_PROTOCOL,
        type: 'response',
        requestId: value.requestId,
        kernelId: this.config.kernelId,
        generation: this.config.generation,
        ok: true,
        ...(result === undefined ? {} : { result }),
      })
    } catch (error) {
      this.output({
        protocol: CLAWX_KERNEL_STDIO_PROTOCOL,
        type: 'response',
        requestId: value.requestId,
        kernelId: this.config.kernelId,
        generation: this.config.generation,
        ok: false,
        error: { code: 'DSH_RUNTIME_ERROR', message: errorMessage(error) },
      })
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.hostBridge?.close()
    await this.engine.close()
    await this.disposeWorld()
  }

  private async dispatch(request: RuntimeRequest): Promise<unknown> {
    if (this.closing && request.method !== 'runtime.health') throw new Error('DeepSeek Harness runtime is shutting down')
    if (request.method === 'runtime.health') {
      return {
        ready: !this.closing,
        status: this.closing ? 'stopping' : 'ready',
        pid: process.pid,
        rssBytes: process.memoryUsage().rss,
        activeRunIds: this.engine.activeRunIds(),
        artifactVersion: this.config.artifactVersion,
      }
    }
    if (request.method === 'runtime.shutdown') {
      await this.close()
      return { accepted: true }
    }
    if (request.method === 'runtime.initialize' || request.method === 'control.initialize') {
      return this.control.initialize((request.params ?? {}) as Parameters<ClawXDshControlBridge['initialize']>[0])
    }
    if (request.method === 'runtime.selfTest') {
      if (this.config.selfTestEnabled !== true || this.selfTest === undefined) {
        throw new Error('DeepSeek Harness runtime self-test is disabled')
      }
      return await this.selfTest()
    }
    if (request.method === 'session.new') {
      const identity = requireIdentity(request)
      return {
        ...identity,
        nativeSessionId: null,
        hydration: 'canonical-on-prompt',
        durableState: 'clawx-data-service',
      }
    }
    if (request.method === 'session.prompt') {
      return await this.engine.prompt({
        ...((request.params ?? {}) as Omit<ClawXDshPromptInput, 'identity'>),
        identity: requireIdentity(request),
      })
    }
    if (request.method === 'session.cancel') return await this.engine.cancel(requireIdentity(request))
    if (request.method === 'session.configure') {
      await this.engine.configure(requireIdentity(request), (request.params ?? {}) as Record<string, unknown>)
      return undefined
    }
    if (request.method === 'session.permission.resolve') {
      await this.engine.resolvePermission(requireIdentity(request), request.params as PermissionResolution)
      return undefined
    }
    return await this.control.dispatch(request.method, request.params)
  }
}

export async function createProductionRuntime(input: {
  config: RuntimeHostConfig
  output: RuntimeOutput
  diagnostic: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void
}): Promise<{ host: ClawXDshRuntimeHost; lock: DshHomeLock }> {
  const { config } = input
  await Promise.all([
    mkdir(config.dataDir, { recursive: true, mode: 0o700 }),
    mkdir(config.configDir, { recursive: true, mode: 0o700 }),
    mkdir(config.cacheDir, { recursive: true, mode: 0o700 }),
    mkdir(join(config.dataDir, 'skills'), { recursive: true, mode: 0o700 }),
  ])
  const lock = await acquireDshHomeLock(join(config.dataDir, 'clawx-runtime.lock'))
  const ctx = new Context()
  let disposeProxy: (() => Promise<void>) | undefined
  let cleanup: Promise<void> | undefined
  const closeResources = (): Promise<void> => cleanup ??= (async () => {
    // Every resource is released even if a preceding teardown fails.
    try { await ctx.fiber.dispose() }
    finally {
      try { await disposeProxy?.() }
      finally { await lock.release() }
    }
  })()
  try {
    // The runtime is its own process, so constraining DSH_HOME here cannot leak
    // into Electron or another kernel generation.
    process.env.DSH_HOME = config.configDir
    const values = Object.fromEntries(Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ))
    const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values }])
    ctx[DSH_LAUNCH_ENVIRONMENT_KEY] = environment
    disposeProxy = await installProxyFromEnvironment(environment, message => input.diagnostic('warn', message))
    ctx.baseUrl = import.meta.url
    // AgentPresets uses the upstream loader to compose user-authored native
    // presets under the managed DSH_HOME. No preset is mounted unless a
    // canonical Agent snapshot explicitly names one.
    await ctx.plugin(Loader, { baseUrl: import.meta.url })
    ctx.loader.builtins.include = Include
    const hostBridge = new ClawXRuntimeHostBridge(config, input.output)
    await ctx.plugin(ClawXDshCredentialProvider, {
      resolve: async ({ accountId, purpose }: { accountId: string; purpose: string }) => {
        const result = await hostBridge.request<{ value?: unknown }>('credential.resolve', { accountId, purpose })
        if (typeof result?.value !== 'string' || result.value.length === 0) {
          throw new Error('ClawX CredentialBroker returned an invalid response')
        }
        return result.value
      },
    })
    await ctx.plugin(LocalAttachmentStore, { dshHome: join(config.cacheDir, 'attachments') })
    await ctx.plugin(SandboxLocal)
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: config.dataDir })
    await ctx.plugin(SubprocessLocal)
    await ctx.plugin(BashSandbox, { timeoutMs: 60_000 })
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(ClawXAgentServices, { dataDir: config.dataDir, configDir: config.configDir })
    await ctx.plugin(LlmDeepSeek, {
      thinking: 'enabled',
      reasoningEffort: 'max',
      models: [
        { id: 'deepseek-v4-flash' },
        { id: 'deepseek-v4-pro' },
        { id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] },
      ],
    })
    await ctx.plugin(FsSandbox, { cwd: config.dataDir })
    await ctx.plugin(FsObservationPolicy)
    await ctx.plugin(ToolFs)
    await ctx.plugin(ToolAskUser)
    await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(AgentPresets, {
      default: 'clawx',
      roots: [],
      includeShippedRoot: false,
      includeUserRoot: true,
    })

    const emit = (event: ClawXDshKernelEvent): void => {
      input.output({
        protocol: CLAWX_KERNEL_STDIO_PROTOCOL,
        type: 'event',
        kernelId: config.kernelId,
        generation: config.generation,
        identity: event.identity,
        eventSeq: event.eventSeq,
        ...(event.nativeEventId ? { nativeEventId: event.nativeEventId } : {}),
        event: event.event,
      })
    }
    const acp = new ClawXDshAcpBridge(ctx, { emit, diagnostic: input.diagnostic })
    const credentials = ctx.credentials as ClawXDshCredentialProvider
    const agentCatalog = new ClawXDshAgentCatalog()
    const skillCatalog = new ClawXDshSkillCatalog(ctx)
    const engine: RuntimeEngine = {
      prompt: prompt => {
        const composition = agentCatalog.resolveForRun({
          agentId: prompt.agentId,
          ...(prompt.agentVersion === undefined ? {} : { canonicalVersion: prompt.agentVersion }),
          workspaceUri: prompt.workspaceUri,
        })
        const request = {
          ...prompt,
          workspaceUri: composition.workspaceUri,
          ...(composition.model ? {
            providerId: composition.model.providerId,
            modelId: composition.model.modelId,
          } : {}),
          ...(composition.persona ? { agentPersona: composition.persona } : {}),
          ...(composition.presetId ? { agentPresetId: composition.presetId } : {}),
        }
        return credentials.withRequestContext({
          accountId: composition.model?.providerAccountId ?? prompt.providerId ?? '',
          purpose: 'model-request',
        }, () => acp.prompt(request))
      },
      cancel: identity => acp.cancel(identity),
      configure: (identity, params) => acp.configure(identity, params),
      resolvePermission: (identity, resolution) => acp.resolvePermission(identity, resolution),
      activeRunIds: () => acp.activeRunIds(),
      close: () => acp.close(),
    }
    const control = new ClawXDshControlBridge({
      artifactVersion: config.artifactVersion,
      generation: config.generation,
      capabilities: DSH_RUNTIME_CAPABILITIES,
      ...(config.capabilitiesDigest ? { capabilitiesDigest: config.capabilitiesDigest } : {}),
      agents: agentCatalog,
      skills: skillCatalog,
      diagnostics: () => ({
        activeRunIds: engine.activeRunIds(),
        dataAuthority: 'clawx-data-service',
        nativeDurableHistory: false,
        dshHome: '<managed-config-root>',
        skillRoot: '<managed-data-root>/skills',
        skillRootPolicy: 'isolated-no-symlink-follow',
      }),
    })
    const host = new ClawXDshRuntimeHost(
      config,
      engine,
      control,
      input.output,
      closeResources,
      () => runProductionSelfTest(ctx, config),
      hostBridge,
    )
    return { host, lock }
  } catch (error) {
    try { await closeResources() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'DSH startup and cleanup failed', { cause: cleanupError }) }
    throw error
  }
}

export function runtimeConfigFromEnvironment(environment: NodeJS.ProcessEnv = process.env): RuntimeHostConfig {
  const kernelId = environment.CLAWX_KERNEL_ID ?? DSH_RUNTIME_KERNEL_ID
  const generation = Number(environment.CLAWX_KERNEL_GENERATION ?? '1')
  const artifactVersion = environment.CLAWX_KERNEL_ARTIFACT_VERSION ?? 'development'
  const dataDir = resolve(environment.CLAWX_KERNEL_DATA_DIR ?? join(process.cwd(), '.clawx-dsh-runtime'))
  const configDir = resolve(environment.CLAWX_KERNEL_CONFIG_DIR ?? join(dataDir, 'config'))
  const cacheDir = resolve(environment.CLAWX_KERNEL_CACHE_DIR ?? join(dataDir, 'cache'))
  if (kernelId !== DSH_RUNTIME_KERNEL_ID) throw new Error(`Unexpected DeepSeek Harness kernel id: ${kernelId}`)
  return {
    kernelId,
    generation,
    artifactVersion,
    dataDir,
    configDir,
    cacheDir,
    ...(environment.CLAWX_KERNEL_CAPABILITIES_DIGEST
      ? { capabilitiesDigest: environment.CLAWX_KERNEL_CAPABILITIES_DIGEST }
      : {}),
    ...(environment.CLAWX_KERNEL_SELF_TEST === '1' ? { selfTestEnabled: true } : {}),
  }
}
