import type { KernelSupervisorRegistry } from '../../kernels/supervisor-registry';
import {
  removeOpenClawAgentProjection,
  setOpenClawDefaultAgentProjection,
  upsertOpenClawAgentProjection,
} from '../../utils/agent-config';
import type { AgentKernelProjectionAdapter } from './agent-projection-reconciler';

export function createOpenClawAgentProjectionAdapter(
  supervisors: KernelSupervisorRegistry,
): AgentKernelProjectionAdapter {
  return {
    kernelId: 'openclaw',
    available: () => supervisors.isLaunchAvailable('openclaw'),
    async upsert(agent) {
      return upsertOpenClawAgentProjection({
        id: agent.id,
        displayName: agent.displayName,
        workspaceUri: agent.workspaceUri,
        ...(agent.model ? {
          model: { providerId: agent.model.providerId, modelId: agent.model.modelId },
        } : {}),
        ...(agent.persona ? { persona: agent.persona } : {}),
      });
    },
    remove: nativeId => removeOpenClawAgentProjection(nativeId),
    setDefault: nativeId => setOpenClawDefaultAgentProjection(nativeId),
  };
}
