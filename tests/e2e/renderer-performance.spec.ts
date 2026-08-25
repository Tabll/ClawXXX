import { writeFile } from 'node:fs/promises';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import type { KernelEventEnvelopeV1 } from '../../shared/kernels/contracts';
import {
  closeElectronApp,
  emitKernelEvents,
  expect,
  getStableWindow,
  installIpcMocks,
  startMainCpuProfile,
  stopMainCpuProfile,
  test,
} from './fixtures/electron';
import { E2E_PERFORMANCE_TAG } from './parallel-policy';

const SESSION_KEY = 'agent:main:performance';
const DSH_SESSION_KEY = 'agent:main:performance-dsh';
const WORKSPACE = '/synthetic-workspace';
const HISTORY_TURNS = 80;
const STREAM_CHUNKS = 300;
const STREAM_INTERVAL_MS = 2;
const STREAM_SENTINEL = 'STREAM-PROFILE-COMPLETE';
const DUAL_STREAM_CHUNKS = 160;
const OPENCLAW_DUAL_SENTINEL = 'OPENCLAW-DUAL-STREAM-COMPLETE';
const DSH_DUAL_SENTINEL = 'DSH-DUAL-STREAM-COMPLETE';
const INTERACTION_SECTIONS = 32;
const INTERACTION_SCROLL_STEPS = 32;

type PerformanceMetric = { name: string; value: number };

type FramePacing = {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  over20Ms: number;
  over34Ms: number;
};

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

function metricMap(metrics: PerformanceMetric[]): Record<string, number> {
  return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
}

function metricDelta(
  before: Record<string, number>,
  after: Record<string, number>,
  name: string,
): number | null {
  const start = before[name];
  const end = after[name];
  return typeof start === 'number' && typeof end === 'number' ? end - start : null;
}

function performanceConversation(
  sessionKey: string,
  kernelId: 'openclaw' | 'deepseek-harness',
  title: string,
  running: boolean,
  historicalTurns: Array<{ id: string; role: 'user' | 'assistant'; text: string }> = [],
) {
  const turnId = `turn-${kernelId}`;
  const runId = `run-${kernelId}`;
  const summary = {
    id: sessionKey,
    title,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: kernelId === 'openclaw' ? '2026-08-24T00:00:02.000Z' : '2026-08-24T00:00:01.000Z',
    workspaceUri: `file://${WORKSPACE}`,
    lastKernelId: kernelId,
    kernelIds: [kernelId],
    lastAgentId: 'main',
    ...(running ? { hasActiveRun: true } : {}),
  };
  return {
    summary,
    export: running ? {
      schema: 'clawx.conversation-export/v1',
      conversation: summary,
      turns: [
        ...historicalTurns.map((turn, position) => ({
          id: turn.id,
          role: turn.role,
          position,
          createdAt: new Date(Date.parse(summary.createdAt) + position).toISOString(),
          blocks: [{ id: `${turn.id}-text`, type: 'text' as const, visibility: 'portable' as const, text: turn.text }],
        })),
        {
          id: turnId,
          role: 'user' as const,
          position: historicalTurns.length,
          createdAt: summary.createdAt,
          blocks: [{ id: `prompt-${kernelId}`, type: 'text' as const, visibility: 'portable' as const, text: `${title} active stream` }],
        },
      ],
      runs: [{
        id: runId,
        turnId,
        kernelId,
        kernelVersion: kernelId === 'openclaw' ? '2026.8.1-clawx.1' : '0.1.0-clawx.1',
        generation: 1,
        agentId: 'main',
        agentSnapshot: {
          agentId: 'main',
          displayName: 'Main',
          kernelId,
          workspaceUri: `file://${WORKSPACE}`,
          canonicalVersion: 1,
        },
        workspaceUri: `file://${WORKSPACE}`,
        status: 'running',
        createdAt: summary.createdAt,
        startedAt: summary.createdAt,
        events: [],
      }],
      usage: [],
    } : null,
    selection: {
      success: true,
      generation: 1,
      kernelId,
      ...(running ? { runId, turnId, resumedActivePrompt: true } : {}),
    },
  };
}

async function openSyntheticChat(
  app: ElectronApplication,
  options: {
    dualActive?: boolean;
    historyTurns?: number;
    richMarkdown?: string;
  } = {},
): Promise<Page> {
  const historicalTurns = options.richMarkdown
    ? [
        { id: 'interaction-user', role: 'user' as const, text: 'Render a comprehensive Markdown fixture.' },
        { id: 'interaction-assistant', role: 'assistant' as const, text: options.richMarkdown },
      ]
    : Array.from({ length: (options.historyTurns ?? 0) * 2 }, (_, index) => ({
        id: `profile-history-${index}`,
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        text: index % 2 === 0
          ? `Synthetic question ${Math.floor(index / 2) + 1}`
          : `Synthetic answer ${Math.floor(index / 2) + 1} with **Markdown** and \`inline code\`.`,
      }));
  const openClaw = performanceConversation(
    SESSION_KEY,
    'openclaw',
    'Performance fixture',
    true,
    historicalTurns,
  );
  const dsh = performanceConversation(DSH_SESSION_KEY, 'deepseek-harness', 'DSH performance fixture', Boolean(options.dualActive));
  await installIpcMocks(app, {
    kernelFixture: {
      catalog: {
        source: 'network',
        stale: false,
        refreshedAt: '2026-08-24T00:00:00.000Z',
        entries: [
          {
            kernelId: 'openclaw',
            displayName: 'OpenClaw',
            installation: { kernelId: 'openclaw', state: 'installed', activeVersion: '2026.8.1-clawx.1', updatedAt: '2026-08-24T00:00:00.000Z' },
            runtime: { kernelId: 'openclaw', state: 'ready', generation: 1, artifactVersion: '2026.8.1-clawx.1', diagnostics: [] },
            updateAvailable: false,
            installAllowed: true,
            compatibilityFailures: [],
          },
          {
            kernelId: 'deepseek-harness',
            displayName: 'DeepSeek Harness',
            installation: { kernelId: 'deepseek-harness', state: 'installed', activeVersion: '0.1.0-clawx.1', updatedAt: '2026-08-24T00:00:00.000Z' },
            runtime: { kernelId: 'deepseek-harness', state: 'ready', generation: 1, artifactVersion: '0.1.0-clawx.1', diagnostics: [] },
            updateAvailable: false,
            installAllowed: true,
            compatibilityFailures: [],
          },
        ],
      },
      runtimes: [
        { kernelId: 'openclaw', state: 'ready', generation: 1, artifactVersion: '2026.8.1-clawx.1', diagnostics: [] },
        { kernelId: 'deepseek-harness', state: 'ready', generation: 1, artifactVersion: '0.1.0-clawx.1', diagnostics: [] },
      ],
    },
    hostApi: {
      [stableStringify(['settings', 'getAll', null])]: {
        language: 'en', setupComplete: true, chatWorkspacePath: WORKSPACE, recentWorkspacePaths: [WORKSPACE],
      },
      [stableStringify(['conversations', 'list', { limit: 100 }])]: {
        items: [openClaw.summary, dsh.summary],
      },
      [stableStringify(['conversations', 'get', { id: SESSION_KEY }])]: openClaw.export,
      [stableStringify(['conversations', 'get', { id: DSH_SESSION_KEY }])]: dsh.export,
      [stableStringify(['chat', 'selectConversationKernel', {
        sessionKey: SESSION_KEY,
        workspaceRoot: WORKSPACE,
        cwd: WORKSPACE,
        kernelId: 'openclaw',
      }])]: openClaw.selection,
      [stableStringify(['chat', 'selectConversationKernel', {
        sessionKey: DSH_SESSION_KEY,
        workspaceRoot: WORKSPACE,
        cwd: WORKSPACE,
        kernelId: 'deepseek-harness',
      }])]: dsh.selection,
      [stableStringify(['files', 'resolveWorkspaceContext', {
        workspaceRoot: WORKSPACE,
        executionCwd: WORKSPACE,
      }])]: { ok: true, workspaceRoot: WORKSPACE, executionCwd: WORKSPACE },
      [stableStringify(['agents', 'list', null])]: {
        success: true,
        agents: [{
          id: 'main', name: 'main', workspace: WORKSPACE, mainSessionKey: SESSION_KEY,
          supportedKernels: ['openclaw', 'deepseek-harness'], defaultForKernels: ['openclaw'], projections: [], channelTypes: [],
        }],
        defaultAgentId: 'main',
        configuredChannelTypes: [],
        channelOwners: {},
        channelAccountOwners: {},
      },
      [stableStringify(['providers', 'accounts', null])]: [],
      [stableStringify(['providers', 'accountKeyInfo', null])]: [],
      [stableStringify(['providers', 'vendors', null])]: [],
      [stableStringify(['providers', 'getDefaultAccount', null])]: { accountId: null },
      [stableStringify(['providers', 'kernelDefaults', null])]: [],
    },
  });

  const page = await getStableWindow(app);
  try {
    await page.reload();
  } catch (error) {
    if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
  }
  await expect(page.getByTestId('main-layout')).toBeVisible();
  await expect(page.getByText('Performance fixture active stream')).toBeVisible({ timeout: 30_000 });
  return page;
}

async function waitForPaint(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

async function startFrameSampling(page: Page, durationMs: number): Promise<void> {
  await page.evaluate((duration) => {
    const perfWindow = window as typeof window & { __clawxPerfFrameSamples?: number[] };
    const samples: number[] = [];
    let previous = performance.now();
    const deadline = previous + duration;
    const sample = (now: number) => {
      samples.push(now - previous);
      previous = now;
      if (now < deadline) requestAnimationFrame(sample);
    };
    perfWindow.__clawxPerfFrameSamples = samples;
    requestAnimationFrame(sample);
  }, durationMs);
}

async function readFramePacing(page: Page): Promise<FramePacing> {
  const samples = await page.evaluate(() => (
    (window as typeof window & { __clawxPerfFrameSamples?: number[] }).__clawxPerfFrameSamples ?? []
  ));
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: samples.length,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    maxMs: Math.max(0, ...samples),
    over20Ms: samples.filter((duration) => duration > 20).length,
    over34Ms: samples.filter((duration) => duration > 34).length,
  };
}

function richStaticMarkdown(): string {
  return Array.from({ length: INTERACTION_SECTIONS }, (_, index) => `
## Rich Markdown section ${index + 1}

This paragraph contains **bold text**, *emphasis*, ~~strikethrough~~, a [safe link](https://example.com), and CJK punctuation：中文、日本語、한국어。

- Nested item ${index + 1}.1
- Nested item ${index + 1}.2 with \`inline code\`

| Column A | Column B | Column C |
| --- | ---: | :---: |
| row ${index + 1} | value ${index * 17} | $x_${index + 1}^2$ |

\`\`\`javascript
function section${index + 1}(value) {
  return value * ${index + 1};
}
\`\`\`
`).join('\n');
}

async function writeArtifact(testInfo: TestInfo, name: string, body: unknown): Promise<string> {
  const path = testInfo.outputPath(name);
  await writeFile(path, JSON.stringify(body));
  await testInfo.attach(name, { path, contentType: 'application/json' });
  return path;
}

test.use({ trace: 'off', video: 'off' });

test('profiles a populated timeline during a growing Markdown stream', {
  tag: E2E_PERFORMANCE_TAG,
}, async ({ launchElectronApp }, testInfo) => {
  const app = await launchElectronApp({ skipSetup: true });

  try {
    const page = await openSyntheticChat(app, { historyTurns: HISTORY_TURNS });
    await expect(page.getByText(`Synthetic answer ${HISTORY_TURNS} with`)).toBeVisible({ timeout: 30_000 });
    await waitForPaint(page);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const beforeMetrics = metricMap((await cdp.send('Performance.getMetrics')).metrics as PerformanceMetric[]);
    await page.evaluate(() => {
      const longTasks: number[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      try {
        observer.observe({ type: 'longtask', buffered: false });
      } catch {
        // Some Electron builds do not expose the Long Tasks API.
      }
      Object.assign(window, { __clawxPerfLongTasks: longTasks, __clawxPerfObserver: observer });
    });

    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1_000 });
    await startMainCpuProfile(app);
    await cdp.send('Profiler.start');
    const startedAt = Date.now();

    const liveEvents: KernelEventEnvelopeV1[] = Array.from({ length: STREAM_CHUNKS }, (_, index) => ({
      protocol: 'clawx.kernel/v1',
      conversationId: SESSION_KEY,
      turnId: 'turn-openclaw',
      runId: 'run-openclaw',
      kernelId: 'openclaw',
      generation: 1,
      eventSeq: index + 1,
      emittedAt: new Date(Date.parse('2026-08-24T00:00:10.000Z') + index).toISOString(),
      event: {
        kind: 'assistant.delta',
        payload: {
          text: index === STREAM_CHUNKS - 1
            ? `\n\n${STREAM_SENTINEL}`
            : `Chunk ${index + 1}: **bold** value ${index % 17}\n\n`,
        },
      },
    }));
    await emitKernelEvents(app, liveEvents, STREAM_INTERVAL_MS);
    await expect(page.getByTestId('acp-assistant-message').filter({ hasText: STREAM_SENTINEL })).toBeVisible({
      timeout: 30_000,
    });
    await waitForPaint(page);

    const elapsedMs = Date.now() - startedAt;
    const rendererProfile = (await cdp.send('Profiler.stop')).profile;
    const mainProfile = await stopMainCpuProfile(app);
    const afterMetrics = metricMap((await cdp.send('Performance.getMetrics')).metrics as PerformanceMetric[]);
    const longTasks = await page.evaluate(() => {
      const perfWindow = window as typeof window & {
        __clawxPerfLongTasks?: number[];
        __clawxPerfObserver?: PerformanceObserver;
      };
      perfWindow.__clawxPerfObserver?.disconnect();
      return perfWindow.__clawxPerfLongTasks ?? [];
    });
    await cdp.detach();

    const benchmark = {
      schemaVersion: 1,
      scope: {
        renderer: 'production-renderer-store-and-render-path',
        main: 'synthetic-main-to-renderer-ipc-fanout',
      },
      workload: {
        historyTurns: HISTORY_TURNS,
        streamChunks: STREAM_CHUNKS,
        streamIntervalMs: STREAM_INTERVAL_MS,
      },
      runtime: {
        platform: process.platform,
        arch: process.arch,
        electron: await app.evaluate(async () => process.versions.electron),
        chrome: await app.evaluate(async () => process.versions.chrome),
      },
      elapsedMs,
      renderer: {
        taskDurationMs: metricDelta(beforeMetrics, afterMetrics, 'TaskDuration')! * 1_000,
        scriptDurationMs: metricDelta(beforeMetrics, afterMetrics, 'ScriptDuration')! * 1_000,
        layoutDurationMs: metricDelta(beforeMetrics, afterMetrics, 'LayoutDuration')! * 1_000,
        recalcStyleDurationMs: metricDelta(beforeMetrics, afterMetrics, 'RecalcStyleDuration')! * 1_000,
        jsHeapUsedSizeDelta: metricDelta(beforeMetrics, afterMetrics, 'JSHeapUsedSize'),
        nodesDelta: metricDelta(beforeMetrics, afterMetrics, 'Nodes'),
        longTasks: {
          count: longTasks.length,
          totalDurationMs: longTasks.reduce((total, duration) => total + duration, 0),
          maxDurationMs: Math.max(0, ...longTasks),
        },
      },
    };

    await Promise.all([
      writeArtifact(testInfo, 'renderer-benchmark.json', benchmark),
      writeArtifact(testInfo, 'renderer.cpuprofile', rendererProfile),
      writeArtifact(testInfo, 'main.cpuprofile', mainProfile),
    ]);
    console.log(`ClawX chat performance: ${JSON.stringify(benchmark)}`);

    expect(liveEvents).toHaveLength(STREAM_CHUNKS);
    const streamedMessage = page.getByTestId('acp-assistant-message').filter({ hasText: STREAM_SENTINEL });
    await expect(streamedMessage).toHaveCount(1);
    const renderedText = await streamedMessage.textContent() ?? '';
    let previousChunkOffset = -1;
    for (let index = 1; index <= STREAM_CHUNKS - 1; index += 1) {
      const offset = renderedText.indexOf(`Chunk ${index}:`);
      expect(offset, `stream chunk ${index} should be present and ordered`).toBeGreaterThan(previousChunkOffset);
      previousChunkOffset = offset;
    }
  } finally {
    await closeElectronApp(app);
  }
});

test('profiles two kernels streaming concurrently into isolated Conversation timelines', {
  tag: E2E_PERFORMANCE_TAG,
}, async ({ launchElectronApp }, testInfo) => {
  const app = await launchElectronApp({ skipSetup: true });

  try {
    const page = await openSyntheticChat(app, { dualActive: true });
    const dshSession = page.getByTestId(`sidebar-session-${DSH_SESSION_KEY}`);
    const openClawSession = page.getByTestId(`sidebar-session-${SESSION_KEY}`);

    // Hydrate both active-run snapshots before interleaving events so the
    // background Conversation exercises the production isolation path.
    await dshSession.click();
    await expect(page.getByText('DSH performance fixture active stream')).toBeVisible();
    await openClawSession.click();
    await expect(page.getByText('Performance fixture active stream')).toBeVisible();

    const events: KernelEventEnvelopeV1[] = [];
    for (let index = 0; index < DUAL_STREAM_CHUNKS; index += 1) {
      const eventSeq = index + 1;
      const emittedAt = new Date(Date.parse('2026-08-24T00:00:10.000Z') + index).toISOString();
      events.push({
        protocol: 'clawx.kernel/v1',
        conversationId: SESSION_KEY,
        turnId: 'turn-openclaw',
        runId: 'run-openclaw',
        kernelId: 'openclaw',
        generation: 1,
        eventSeq,
        emittedAt,
        event: {
          kind: 'assistant.delta',
          payload: {
            text: index === DUAL_STREAM_CHUNKS - 1
              ? `OpenClaw chunk ${eventSeq}. ${OPENCLAW_DUAL_SENTINEL}`
              : `OpenClaw chunk ${eventSeq}. `,
          },
        },
      }, {
        protocol: 'clawx.kernel/v1',
        conversationId: DSH_SESSION_KEY,
        turnId: 'turn-deepseek-harness',
        runId: 'run-deepseek-harness',
        kernelId: 'deepseek-harness',
        generation: 1,
        eventSeq,
        emittedAt,
        event: {
          kind: 'assistant.delta',
          payload: {
            text: index === DUAL_STREAM_CHUNKS - 1
              ? `DSH chunk ${eventSeq}. ${DSH_DUAL_SENTINEL}`
              : `DSH chunk ${eventSeq}. `,
          },
        },
      });
    }

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1_000 });
    await startMainCpuProfile(app);
    await cdp.send('Profiler.start');
    const beforeMetrics = metricMap((await cdp.send('Performance.getMetrics')).metrics as PerformanceMetric[]);
    await startFrameSampling(page, 2_500);
    const startedAt = Date.now();

    await emitKernelEvents(app, events, STREAM_INTERVAL_MS);
    await expect(page.getByTestId('acp-assistant-message').filter({ hasText: OPENCLAW_DUAL_SENTINEL }))
      .toBeVisible({ timeout: 30_000 });
    await dshSession.click();
    const dshMessage = page.getByTestId('acp-assistant-message').filter({ hasText: DSH_DUAL_SENTINEL });
    await expect(dshMessage).toBeVisible({ timeout: 30_000 });
    await openClawSession.click();
    const openClawMessage = page.getByTestId('acp-assistant-message').filter({ hasText: OPENCLAW_DUAL_SENTINEL });
    await expect(openClawMessage).toBeVisible();
    await page.waitForTimeout(600);

    const elapsedMs = Date.now() - startedAt;
    const frames = await readFramePacing(page);
    const rendererProfile = (await cdp.send('Profiler.stop')).profile;
    const mainProfile = await stopMainCpuProfile(app);
    const afterMetrics = metricMap((await cdp.send('Performance.getMetrics')).metrics as PerformanceMetric[]);
    await cdp.detach();

    const approvedBudget = {
      maxElapsedMs: 15_000,
      maxP95FrameMs: 250,
      minimumEventsPerSecond: 20,
    };
    const eventsPerSecond = events.length / Math.max(elapsedMs / 1_000, 0.001);
    const benchmark = {
      schemaVersion: 1,
      workload: {
        kernels: ['openclaw', 'deepseek-harness'],
        concurrentStreams: 2,
        chunksPerKernel: DUAL_STREAM_CHUNKS,
        totalEvents: events.length,
        streamIntervalMs: STREAM_INTERVAL_MS,
      },
      approvedBudget,
      elapsedMs,
      eventsPerSecond,
      frames,
      renderer: {
        taskDurationMs: metricDelta(beforeMetrics, afterMetrics, 'TaskDuration')! * 1_000,
        scriptDurationMs: metricDelta(beforeMetrics, afterMetrics, 'ScriptDuration')! * 1_000,
        layoutDurationMs: metricDelta(beforeMetrics, afterMetrics, 'LayoutDuration')! * 1_000,
        recalcStyleDurationMs: metricDelta(beforeMetrics, afterMetrics, 'RecalcStyleDuration')! * 1_000,
        jsHeapUsedSizeDelta: metricDelta(beforeMetrics, afterMetrics, 'JSHeapUsedSize'),
        nodesDelta: metricDelta(beforeMetrics, afterMetrics, 'Nodes'),
      },
    };
    await Promise.all([
      writeArtifact(testInfo, 'renderer-dual-kernel-benchmark.json', benchmark),
      writeArtifact(testInfo, 'renderer-dual-kernel.cpuprofile', rendererProfile),
      writeArtifact(testInfo, 'main-dual-kernel.cpuprofile', mainProfile),
    ]);
    console.log(`ClawX dual-kernel performance: ${JSON.stringify(benchmark)}`);

    expect(events).toHaveLength(DUAL_STREAM_CHUNKS * 2);
    expect(await openClawMessage.textContent()).toContain('OpenClaw chunk 1.');
    await dshSession.click();
    await expect(dshMessage).toContainText('DSH chunk 1.');
    expect(elapsedMs).toBeLessThanOrEqual(approvedBudget.maxElapsedMs);
    expect(frames.count).toBeGreaterThan(0);
    expect(frames.p95Ms).toBeLessThanOrEqual(approvedBudget.maxP95FrameMs);
    expect(eventsPerSecond).toBeGreaterThanOrEqual(approvedBudget.minimumEventsPerSecond);
  } finally {
    await closeElectronApp(app);
  }
});

test('profiles sidebar animation and scrolling with rich static Markdown', {
  tag: E2E_PERFORMANCE_TAG,
}, async ({ launchElectronApp }, testInfo) => {
  const app = await launchElectronApp({ skipSetup: true });

  try {
    const markdown = richStaticMarkdown();
    const page = await openSyntheticChat(app, { richMarkdown: markdown });
    const terminalSection = page.getByRole('heading', { name: `Rich Markdown section ${INTERACTION_SECTIONS}` });
    await expect(terminalSection).toBeAttached({ timeout: 30_000 });
    await expect(page.locator('.clawx-streamdown [data-streamdown="code-block-body"] pre').first()).toBeAttached({ timeout: 30_000 });
    await waitForPaint(page);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1_000 });
    await startMainCpuProfile(app);
    await cdp.send('Profiler.start');
    const beforeMetrics = metricMap((await cdp.send('Performance.getMetrics')).metrics as PerformanceMetric[]);

    const sidebar = page.getByTestId('sidebar');
    await startFrameSampling(page, 500);
    await page.getByTestId('sidebar-collapse-toggle').click();
    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBe(68);
    await page.waitForTimeout(550);
    const sidebarCollapseFrames = await readFramePacing(page);

    await startFrameSampling(page, 500);
    await page.getByTestId('sidebar-collapse-toggle').click();
    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan(200);
    await page.waitForTimeout(550);
    const sidebarExpandFrames = await readFramePacing(page);
    const scrollContainer = page.getByTestId('chat-scroll-container');
    const scrollStart = await scrollContainer.evaluate((element) => {
      element.scrollTop = 0;
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      };
    });
    expect(scrollStart.scrollHeight).toBeGreaterThan(scrollStart.clientHeight);
    const scrollBox = await scrollContainer.boundingBox();
    if (!scrollBox) throw new Error('Rich Markdown scroll container has no layout box');

    await startFrameSampling(page, 1_600);
    await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2);
    for (let index = 0; index < INTERACTION_SCROLL_STEPS; index += 1) {
      await page.mouse.wheel(0, 180);
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(650);
    const scrollFrames = await readFramePacing(page);
    const scrollEnd = await scrollContainer.evaluate((element) => element.scrollTop);

    const rendererProfile = (await cdp.send('Profiler.stop')).profile;
    const mainProfile = await stopMainCpuProfile(app);
    const afterMetrics = metricMap((await cdp.send('Performance.getMetrics')).metrics as PerformanceMetric[]);
    const gpu = await app.evaluate(async ({ app: electronApp }) => ({
      hardwareAccelerationEnabled: electronApp.isHardwareAccelerationEnabled(),
      gpuCompositing: electronApp.getGPUFeatureStatus().gpu_compositing,
      rasterization: electronApp.getGPUFeatureStatus().rasterization,
    }));
    const dom = await page.evaluate(() => ({
      nodes: document.getElementsByTagName('*').length,
      markdownNodes: document.querySelectorAll('.clawx-streamdown *').length,
    }));
    await cdp.detach();

    const benchmark = {
      schemaVersion: 1,
      workload: {
        markdownCharacters: markdown.length,
        markdownSections: INTERACTION_SECTIONS,
        scrollSteps: INTERACTION_SCROLL_STEPS,
      },
      gpu,
      dom,
      sidebarCollapseFrames,
      sidebarExpandFrames,
      scrollFrames,
      scrollDistance: scrollEnd - scrollStart.scrollTop,
      renderer: {
        taskDurationMs: metricDelta(beforeMetrics, afterMetrics, 'TaskDuration')! * 1_000,
        scriptDurationMs: metricDelta(beforeMetrics, afterMetrics, 'ScriptDuration')! * 1_000,
        layoutDurationMs: metricDelta(beforeMetrics, afterMetrics, 'LayoutDuration')! * 1_000,
        recalcStyleDurationMs: metricDelta(beforeMetrics, afterMetrics, 'RecalcStyleDuration')! * 1_000,
      },
    };

    await Promise.all([
      writeArtifact(testInfo, 'renderer-interaction-benchmark.json', benchmark),
      writeArtifact(testInfo, 'renderer-interaction.cpuprofile', rendererProfile),
      writeArtifact(testInfo, 'main-interaction.cpuprofile', mainProfile),
    ]);
    console.log(`ClawX interaction performance: ${JSON.stringify(benchmark)}`);

    expect(markdown.length).toBeGreaterThan(10_000);
    expect(sidebarCollapseFrames.count).toBeGreaterThan(0);
    expect(sidebarExpandFrames.count).toBeGreaterThan(0);
    expect(scrollFrames.count).toBeGreaterThan(0);
    expect(scrollEnd - scrollStart.scrollTop).toBeGreaterThan(1_000);
  } finally {
    await closeElectronApp(app);
  }
});
