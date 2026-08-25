import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import type { GatewayManager } from '../gateway/manager';
import { logger } from '../utils/logger';
import { getOpenClawConfigDir } from '../utils/paths';
import { buildGatewayHealthSummary } from '../utils/gateway-health';
import { buildChannelAccountsView, getChannelStatusDiagnostics } from './channels-api';
import { getAcpTraceSnapshot, recordRendererAcpTrace } from './acp-trace';
import { redactDiagnosticText } from '../kernels/log-redaction';
import type { ExtensionHostKernelApi } from '@shared/extensions/kernel-api';
import type { DiagnosticsSnapshotResult, KernelDiagnosticsSnapshot } from '@shared/domains/diagnostics';

const DEFAULT_TAIL_LINES = 200;

type DiagnosticsApiContext = {
  gatewayManager: GatewayManager;
  kernels?: ExtensionHostKernelApi;
};

function sanitizeGatewayRecovery(
  recovery: ReturnType<GatewayManager['getDiagnostics']>['recovery'],
) {
  if (!recovery) return undefined;

  return {
    state: recovery.state,
    lastAliveAt: recovery.lastAliveAt,
    deadlineAt: recovery.deadlineAt,
    lastDeadlineProbeAt: recovery.lastDeadlineProbeAt,
    lastDeadlineProbeResult: recovery.lastDeadlineProbeResult,
    lastDeadlineProbeError: recovery.lastDeadlineProbeError,
    escalationReason: recovery.escalationReason,
    externallyManaged: recovery.externallyManaged,
  };
}

async function readTail(filePath: string, tailLines = DEFAULT_TAIL_LINES): Promise<string> {
  const safeTailLines = Math.max(1, Math.floor(tailLines));
  try {
    const file = await open(filePath, 'r');
    try {
      const stat = await file.stat();
      if (stat.size === 0) return '';

      const chunkSize = 64 * 1024;
      let position = stat.size;
      let content = '';
      let lineCount = 0;

      while (position > 0 && lineCount <= safeTailLines) {
        const bytesToRead = Math.min(chunkSize, position);
        position -= bytesToRead;
        const buffer = Buffer.allocUnsafe(bytesToRead);
        const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
        content = `${buffer.subarray(0, bytesRead).toString('utf-8')}${content}`;
        lineCount = content.split('\n').length - 1;
      }

      const lines = content.split('\n');
      return redactDiagnosticText(
        lines.length <= safeTailLines ? content : lines.slice(-safeTailLines).join('\n'),
      );
    } finally {
      await file.close();
    }
  } catch {
    return '';
  }
}

async function buildKernelDiagnostics(
  kernels: ExtensionHostKernelApi | undefined,
): Promise<DiagnosticsSnapshotResult> {
  const capturedAt = new Date().toISOString();
  if (!kernels) {
    return { capturedAt, platform: process.platform, arch: process.arch, kernels: [] };
  }
  const snapshots = await kernels.list();
  const results = await Promise.all(snapshots.map(async (snapshot): Promise<KernelDiagnosticsSnapshot> => {
    const diagnostics = kernels.diagnostics(snapshot.kernelId);
    const installation = await kernels.getInstallation(snapshot.kernelId).catch(() => undefined);
    const runtimeVersion = snapshot.artifactVersion
      ? await kernels.getRuntimeVersion(snapshot.kernelId, snapshot.artifactVersion).catch(() => undefined)
      : undefined;
    const installedManifest = installation?.manifest;
    const manifest = runtimeVersion?.manifest
      ?? (installedManifest?.artifactVersion === snapshot.artifactVersion
        ? installedManifest
        : undefined);
    const capabilities = snapshot.capabilities ?? kernels.getDriver(snapshot.kernelId)?.definition.capabilities;
    const lastSequence = diagnostics.logs.at(-1)?.sequence;
    return {
      capturedAt,
      kernelId: snapshot.kernelId,
      artifact: {
        installationState: installation?.state ?? 'unknown',
        activeVersion: installation?.activeVersion,
        desiredVersion: installation?.desiredVersion,
        lastKnownGoodVersion: installation?.lastKnownGoodVersion,
        artifactVersion: snapshot.artifactVersion ?? manifest?.artifactVersion,
        upstreamVersion: manifest?.upstreamVersion,
        upstreamCommit: manifest?.upstreamCommit,
        patchRevision: manifest?.patchRevision,
        platform: manifest?.platform,
        arch: manifest?.arch,
        archiveSha256: manifest?.archive.sha256,
        fileManifestSha256: manifest?.supplyChain.fileManifestSha256,
        patchSeriesSha256: manifest?.supplyChain.patchSeriesSha256,
        licenseReportSha256: manifest?.supplyChain.licenseReportSha256,
        platformSecurityReportSha256: manifest?.supplyChain.platformSecurityReportSha256,
      },
      protocol: {
        kernelContract: 'clawx.kernel/v1',
        runtimeTransport: snapshot.runtimeTransport,
        chat: manifest?.protocols.chat,
        control: manifest?.protocols.control,
        conversationStore: manifest?.protocols.conversationStore,
      },
      process: {
        state: snapshot.state,
        generation: snapshot.generation,
        pid: snapshot.pid,
        ownership: snapshot.ownership,
        runtimeVersion: snapshot.version,
        artifactVersion: snapshot.artifactVersion,
        startedAt: snapshot.startedAt,
        startupDurationMs: snapshot.startupDurationMs,
        rssBytes: snapshot.rssBytes,
      },
      health: {
        state: snapshot.state,
        lastHealthAt: snapshot.lastHealthAt,
        lastError: snapshot.lastError ? redactDiagnosticText(snapshot.lastError) : undefined,
        crashCount: diagnostics.crashes.length,
        restartCount: snapshot.restartCount ?? 0,
        restartBudget: snapshot.restartBudget,
        rollbackSuggested: Boolean(snapshot.rollbackSuggested),
      },
      capabilities,
      logs: {
        directory: diagnostics.logDirectory,
        entryCount: diagnostics.logs.length,
        lastSequence,
      },
    };
  }));
  return { capturedAt, platform: process.platform, arch: process.arch, kernels: results };
}

export function createDiagnosticsApi(ctx: DiagnosticsApiContext): CompleteHostServiceRegistry['diagnostics'] {
  return {
    snapshot: async () => buildKernelDiagnostics(ctx.kernels),
    gatewaySnapshot: async () => {
      const { channels } = await buildChannelAccountsView(ctx, { probe: false });
      const diagnostics = ctx.gatewayManager.getDiagnostics?.() ?? {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      };
      const channelStatusDiagnostics = getChannelStatusDiagnostics();
      const gatewayStatus = ctx.gatewayManager.getStatus();
      const gatewaySummary = buildGatewayHealthSummary({
        status: gatewayStatus,
        diagnostics,
        lastChannelsStatusOkAt: channelStatusDiagnostics.lastChannelsStatusOkAt,
        lastChannelsStatusFailureAt: channelStatusDiagnostics.lastChannelsStatusFailureAt,
      });
      const recovery = sanitizeGatewayRecovery(diagnostics.recovery);
      const gateway = {
        ...gatewayStatus,
        ...gatewaySummary,
        recovery,
        capabilities: typeof ctx.gatewayManager.getCapabilitySnapshot === 'function'
          ? ctx.gatewayManager.getCapabilitySnapshot(gatewaySummary)
          : undefined,
      };
      const openClawDir = getOpenClawConfigDir();
      return {
        capturedAt: Date.now(),
        platform: process.platform,
        gateway,
        channels,
        clawxLogTail: redactDiagnosticText(await logger.readLogFile(DEFAULT_TAIL_LINES)),
        gatewayLogTail: await readTail(join(openClawDir, 'logs', 'gateway.log')),
        gatewayErrLogTail: await readTail(join(openClawDir, 'logs', 'gateway.err.log')),
      };
    },
    acpTrace: async () => getAcpTraceSnapshot(),
    recordAcpTrace: async (payload) => recordRendererAcpTrace(payload),
  };
}
