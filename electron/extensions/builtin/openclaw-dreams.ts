import { shell } from 'electron';
import type {
  OpenClawDreamsAction,
  OpenClawDreamsRunPayload,
  OpenClawDreamsTogglePayload,
} from '@shared/host-api/contract';
import type { HostApiContribution, RuntimeHostAction } from '../../main/ipc/host-contract';
import { createGatewayApi } from '../../services/gateway-api';
import type { Extension, ExtensionContext, HostApiProviderExtension } from '../types';

const ACTION_METHODS: Record<OpenClawDreamsAction, string> = {
  backfill: 'doctor.memory.backfillDreamDiary',
  dedupe: 'doctor.memory.dedupeDreamDiary',
  repair: 'doctor.memory.repairDreamingArtifacts',
  resetDiary: 'doctor.memory.resetDreamDiary',
  resetGrounded: 'doctor.memory.resetGroundedShortTerm',
};

function assertAction(payload: unknown): OpenClawDreamsAction {
  const action = payload && typeof payload === 'object'
    ? (payload as OpenClawDreamsRunPayload).action
    : undefined;
  if (!action || !(action in ACTION_METHODS)) throw new Error('Invalid Dreams maintenance action');
  return action;
}

class OpenClawDreamsExtension implements HostApiProviderExtension {
  readonly id = 'builtin/openclaw-dreams';
  readonly supportedKernels = ['openclaw'] as const;

  setup(_ctx: ExtensionContext): void {
    // The legacy transport remains Main-only behind this allowlisted capability surface.
  }

  getHostApiContributions(ctx: ExtensionContext): HostApiContribution[] {
    const gateway = ctx.kernels.legacyOpenClaw.gateway;
    const gatewayApi = createGatewayApi(gateway);
    const actions: Record<string, RuntimeHostAction> = {
      status: () => gateway.rpc('doctor.memory.status', {}, 12_000),
      diary: () => gateway.rpc('doctor.memory.dreamDiary', {}, 12_000),
      run: (payload) => gateway.rpc(ACTION_METHODS[assertAction(payload)], {}, 120_000),
      setEnabled: async (payload) => {
        const enabled = payload && typeof payload === 'object'
          ? (payload as OpenClawDreamsTogglePayload).enabled
          : undefined;
        if (typeof enabled !== 'boolean') throw new Error('Invalid Dreams enabled state');
        const snapshot = await gateway.rpc<{ hash?: string }>('config.get', {}, 12_000);
        if (!snapshot.hash) throw new Error('OpenClaw config hash is unavailable');
        await gateway.rpc('config.patch', {
          raw: JSON.stringify({
            plugins: { entries: { 'memory-core': { config: { dreaming: { enabled } } } } },
          }),
          baseHash: snapshot.hash,
          note: enabled ? 'Enable memory dreaming from ClawX Dreams.' : 'Disable memory dreaming from ClawX Dreams.',
        }, 30_000);
        return { success: true };
      },
      openFullUi: async () => {
        const result = await gatewayApi.controlUi({ view: 'dreams' });
        if (!result.success || !result.url) throw new Error(result.error || 'OpenClaw Control UI is unavailable');
        await shell.openExternal(result.url);
        return { success: true };
      },
    };
    return [{ module: 'openClawDreams', actions }];
  }
}

export function createOpenClawDreamsExtension(): Extension {
  return new OpenClawDreamsExtension();
}
