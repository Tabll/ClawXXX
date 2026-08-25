import { create } from 'zustand';
import { hostApi } from '@/lib/host-api';
import type { ChannelType } from '@/types/channel';
import type { AgentKernelDefault, AgentSummary, AgentsSnapshot } from '@/types/agent';

export type AgentCreateOptions = {
  inheritWorkspace?: boolean;
  kernelIds?: string[];
  workspaceUri?: string;
  description?: string;
  persona?: string;
  presetId?: string;
  modelRef?: string | null;
};

export type AgentUpdateOptions = {
  name?: string;
  kernelIds?: string[];
  workspaceUri?: string;
  description?: string;
  persona?: string;
  presetId?: string;
};

interface AgentsState {
  agents: AgentSummary[];
  kernelDefaults: AgentKernelDefault[];
  defaultModelRef: string | null;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
  channelAccountOwners: Record<string, string>;
  loading: boolean;
  error: string | null;
  fetchAgents: () => Promise<void>;
  createAgent: (name: string, options?: AgentCreateOptions) => Promise<void>;
  updateAgent: (agentId: string, input: AgentUpdateOptions) => Promise<void>;
  updateAgentModel: (agentId: string, modelRef: string | null) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  setKernelDefault: (agentId: string, kernelId: string) => Promise<void>;
  reconcileAgent: (agentId: string, kernelIds?: string[]) => Promise<void>;
  assignChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  removeChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  clearError: () => void;
}

function applySnapshot(snapshot: AgentsSnapshot | undefined) {
  return snapshot ? {
    agents: snapshot.agents ?? [],
    kernelDefaults: snapshot.kernelDefaults ?? [],
    defaultModelRef: snapshot.defaultModelRef ?? null,
    configuredChannelTypes: snapshot.configuredChannelTypes ?? [],
    channelOwners: snapshot.channelOwners ?? {},
    channelAccountOwners: snapshot.channelAccountOwners ?? {},
  } : {};
}

export const useAgentsStore = create<AgentsState>((set) => ({
  agents: [],
  kernelDefaults: [],
  defaultModelRef: null,
  configuredChannelTypes: [],
  channelOwners: {},
  channelAccountOwners: {},
  loading: false,
  error: null,

  fetchAgents: async () => {
    set({ loading: true, error: null });
    try {
      const snapshot = await hostApi.agents.list();
      set({
        ...applySnapshot(snapshot),
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  createAgent: async (name: string, options?: AgentCreateOptions) => {
    set({ error: null });
    try {
      const snapshot = await hostApi.agents.create({
        name,
        inheritWorkspace: options?.inheritWorkspace,
        kernelIds: options?.kernelIds,
        workspaceUri: options?.workspaceUri,
        description: options?.description,
        persona: options?.persona,
        presetId: options?.presetId,
        modelRef: options?.modelRef,
      });
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgent: async (agentId: string, input: AgentUpdateOptions) => {
    set({ error: null });
    try {
      const snapshot = await hostApi.agents.update(agentId, input);
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgentModel: async (agentId: string, modelRef: string | null) => {
    set({ error: null });
    try {
      const snapshot = await hostApi.agents.updateModel(agentId, modelRef);
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  deleteAgent: async (agentId: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApi.agents.delete(agentId);
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  setKernelDefault: async (agentId: string, kernelId: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApi.agents.setDefault(agentId, kernelId);
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  reconcileAgent: async (agentId: string, kernelIds?: string[]) => {
    set({ error: null });
    try {
      const snapshot = await hostApi.agents.reconcile(agentId, kernelIds);
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  assignChannel: async (agentId: string, channelType: ChannelType) => {
    set({ error: null });
    try {
      const snapshot = await hostApi.agents.assignChannel(agentId, channelType);
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  removeChannel: async (agentId: string, channelType: ChannelType) => {
    set({ error: null });
    try {
      const snapshot = await hostApi.agents.removeChannel(agentId, channelType);
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
