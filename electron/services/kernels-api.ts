import type { KernelId, KernelRunIdentity } from '@shared/kernels/contracts';
import { assertExecutionIdentity } from '@shared/host-api/kernels';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import type { KernelSupervisorRegistry } from '../kernels/supervisor-registry';
import { setKernelAutoStartPolicy } from '../kernels/auto-start-policy';
import type { ConversationRouter } from '../conversations/conversation-router';
import type { KernelPackageController } from '../kernels/package-manager/controller';

type KernelsApiOptions = {
  supervisors: KernelSupervisorRegistry;
  persistAutoStart?: (kernelId: KernelId, enabled: boolean) => Promise<void>;
  conversationRouter?: ConversationRouter;
  packages?: KernelPackageController;
};

function requireKernelId(input: unknown): KernelId {
  const kernelId = input && typeof input === 'object'
    ? (input as Record<string, unknown>).kernelId
    : undefined;
  if (typeof kernelId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(kernelId)) {
    throw new Error('Invalid kernelId');
  }
  return kernelId as KernelId;
}

function identityOf(input: KernelRunIdentity) {
  return {
    conversationId: input.conversationId,
    turnId: input.turnId,
    runId: input.runId,
  };
}

function requirePackages(options: KernelsApiOptions): KernelPackageController {
  if (!options.packages) throw new Error('Kernel package distribution is unavailable');
  return options.packages;
}

function assertCurrentGeneration(supervisors: KernelSupervisorRegistry, input: KernelRunIdentity): void {
  assertExecutionIdentity(input);
  const snapshot = supervisors.status(input.kernelId);
  if (snapshot.state !== 'ready' || snapshot.generation !== input.generation) {
    throw new Error(
      `Kernel generation is stale: expected ready generation ${snapshot.generation}, received ${input.generation}`,
    );
  }
}

export function createKernelsApi(
  options: KernelsApiOptions,
): CompleteHostServiceRegistry['kernels'] {
  const persistAutoStart = options.persistAutoStart ?? setKernelAutoStartPolicy;
  return {
    catalog: (payload) => options.packages
      ? options.packages.catalog(payload?.refresh === true)
      : Promise.reject(new Error('Kernel package distribution is unavailable')),
    install: (payload) => requirePackages(options).install(requireKernelId(payload)),
    update: (payload) => requirePackages(options).update(requireKernelId(payload)),
    repair: (payload) => requirePackages(options).repair(requireKernelId(payload)),
    rollback: (payload) => requirePackages(options).rollback(requireKernelId(payload)),
    uninstall: (payload) => requirePackages(options).uninstall(requireKernelId(payload)),
    versions: async (payload) => ({
      versions: await requirePackages(options).versions(requireKernelId(payload)),
    }),
    openDirectory: async (payload) => {
      const kernelId = requireKernelId(payload);
      const kind = payload.kind;
      if (kind !== 'data' && kind !== 'logs') throw new Error('Invalid kernel directory kind');
      await requirePackages(options).openDirectory(kernelId, kind);
      return { success: true as const };
    },
    list: () => options.supervisors.snapshots(),
    status: (payload) => options.supervisors.status(requireKernelId(payload)),
    start: (payload) => options.supervisors.start(requireKernelId(payload)),
    stop: async (payload) => options.supervisors.stop(requireKernelId(payload)),
    restart: (payload) => options.supervisors.restart(requireKernelId(payload)),
    health: (payload) => options.supervisors.health(requireKernelId(payload)),
    logs: (payload) => {
      const kernelId = requireKernelId(payload);
      const body = payload as { afterSequence?: number; limit?: number };
      return options.supervisors.logs(kernelId, {
        afterSequence: body.afterSequence,
        limit: body.limit,
      });
    },
    logDirectory: (payload) => ({
      path: options.supervisors.logDirectory(requireKernelId(payload)),
    }),
    exportLogs: (payload) => options.supervisors.exportLogs(requireKernelId(payload)),
    setAutoStart: async (payload) => {
      const kernelId = requireKernelId(payload);
      const enabled = (payload as { enabled?: unknown }).enabled;
      if (typeof enabled !== 'boolean') throw new Error('Invalid auto-start policy');
      await persistAutoStart(kernelId, enabled);
      return options.supervisors.setPolicy(kernelId, { autoStart: enabled });
    },
    execute: async (input) => {
      if (options.conversationRouter) {
        return options.conversationRouter.prompt({
          conversationId: input.conversationId,
          turnId: input.turnId,
          runId: input.runId,
          kernelId: input.kernelId,
          generation: input.generation,
          agentId: input.agentId,
          workspaceUri: input.workspaceUri,
          providerId: input.providerId,
          modelId: input.modelId,
          blocks: input.context,
          attachments: input.attachments,
        });
      }
      assertCurrentGeneration(options.supervisors, input);
      const { conversationId, turnId, runId, kernelId, generation, ...params } = input;
      await options.supervisors.request(
        kernelId,
        'session.prompt',
        params,
        { conversationId, turnId, runId },
      );
      return { conversationId, turnId, runId, kernelId, generation, acceptedAt: new Date().toISOString() };
    },
    cancel: async (input) => {
      if (options.conversationRouter) return options.conversationRouter.cancel(input);
      assertCurrentGeneration(options.supervisors, input);
      const result = await options.supervisors.request<{ cancelled?: boolean; acknowledged?: boolean }>(
        input.kernelId,
        'session.cancel',
        undefined,
        identityOf(input),
      );
      return { acknowledged: result.acknowledged === true || result.cancelled === true };
    },
    updateConfiguration: async (input) => {
      if (options.conversationRouter) {
        await options.conversationRouter.configure(input);
        return;
      }
      assertCurrentGeneration(options.supervisors, input);
      await options.supervisors.request(
        input.kernelId,
        'session.configure',
        {
          providerId: input.providerId,
          modelId: input.modelId,
          permissionMode: input.permissionMode,
        },
        identityOf(input),
      );
    },
    resolvePermission: async (input) => {
      if (options.conversationRouter) {
        await options.conversationRouter.resolvePermission(input);
        return;
      }
      assertCurrentGeneration(options.supervisors, input);
      await options.supervisors.request(
        input.kernelId,
        'session.permission.resolve',
        { requestId: input.requestId, decision: input.decision },
        identityOf(input),
      );
    },
    diagnostics: (payload) => {
      const kernelId = requireKernelId(payload);
      return {
        ...options.supervisors.diagnostics(kernelId),
        logDirectory: options.supervisors.logDirectory(kernelId),
      };
    },
  };
}
