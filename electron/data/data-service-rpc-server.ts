import type { ClawXDataClient } from './clawx-data-service';
import { ClawXDataService } from './clawx-data-service';
import { CLAWX_DATA_SCHEMA_VERSION } from './schema';
import {
  DATA_SERVICE_RPC_PROTOCOL,
  type DataServiceRpcMessage,
  type DataServiceRpcRequest,
  type DataServiceRpcScope,
} from '@shared/data/rpc';

const CLIENT_METHODS = new Set([
  'createConversation', 'branchConversation', 'getConversation', 'listConversations', 'searchConversations',
  'renameConversation', 'pinConversation', 'deleteConversation', 'exportConversation',
  'admitRun', 'markRunStarted', 'appendEvents', 'commitTerminalRun', 'compileContext',
  'appendUsage', 'listUsage', 'putBlob', 'addBlobRef', 'createAttachmentGrant',
  'putCronJob', 'getCronJob', 'listCronJobs', 'deleteCronJob',
  'admitCron', 'admitCronExecution', 'putCronRun', 'getCronRun', 'listCronRuns',
  'acquireSchedulerLease', 'renewSchedulerLease', 'releaseSchedulerLease', 'getSchedulerLease',
  'readBlob', 'getConversationBlobMetadata', 'readConversationBlob',
  'garbageCollectBlobs',
  'putChannelAccount', 'getChannelAccount', 'listChannelAccounts', 'deleteChannelAccount',
  'putChannelBinding', 'getChannelBinding', 'resolveChannelBinding', 'listChannelBindings', 'deleteChannelBinding',
  'acquireChannelOwnerLease', 'renewChannelOwnerLease', 'releaseChannelOwnerLease', 'getChannelOwnerLease',
  'admitChannelMessage', 'updateChannelMessage', 'getChannelMessage', 'listChannelMessages', 'listPendingChannelDeliveries',
  'recordChannelDeliveryAttempt', 'listChannelDeliveryAttempts',
  'putSkill', 'getSkill', 'listSkills', 'deleteSkill',
  'putAgent', 'getAgent', 'listAgents', 'deleteAgent',
  'setAgentDefault', 'clearAgentDefault', 'getAgentDefault', 'listAgentDefaults',
  'putProvider', 'getProvider', 'listProviders', 'deleteProvider',
  'setProviderDefault', 'clearProviderDefault', 'getProviderDefault', 'listProviderDefaults',
  'putOperation', 'completeOperation',
  'upsertProjection', 'deleteProjection', 'listProjections', 'putCheckpoint', 'getCheckpoint', 'getLatestConversationCheckpoint',
  'getKernelCatalogState', 'putKernelCatalogState',
  'getKernelInstallation', 'listKernelInstallations', 'putKernelInstallation',
  'upsertKernelRuntimeVersion', 'getKernelRuntimeVersion', 'listKernelRuntimeVersions', 'removeKernelRuntimeVersion',
  'commitKernelActivation', 'listKernelActivationHistory',
  'listRunEvents', 'getRunArtifacts', 'integrityCheck', 'backupTo',
]);

type ClientCall = { method: string; args?: unknown[] };

export class DataServiceRpcServer {
  private readonly service: ClawXDataService;
  private readonly clients = new Map<string, ClawXDataClient>();

  constructor(databasePath: string, blobRoot?: string) {
    this.service = new ClawXDataService(databasePath, undefined, blobRoot);
  }

  ready(): DataServiceRpcMessage {
    return {
      protocol: DATA_SERVICE_RPC_PROTOCOL,
      type: 'ready',
      schemaVersion: CLAWX_DATA_SCHEMA_VERSION,
      pid: process.pid,
    };
  }

  async handle(request: DataServiceRpcRequest): Promise<DataServiceRpcMessage> {
    if (request.protocol !== DATA_SERVICE_RPC_PROTOCOL || request.type !== 'request') {
      return this.failure(request.requestId, 'PROTOCOL_MISMATCH', 'Unsupported DataService protocol');
    }
    try {
      switch (request.method) {
        case 'service.connect': {
          if (!request.clientId || this.clients.has(request.clientId)) throw new Error('Invalid or duplicate DataService client ID');
          const scope = request.params as DataServiceRpcScope;
          if (!scope || (scope.role !== 'main' && scope.role !== 'kernel')) throw new Error('Invalid DataService client scope');
          this.clients.set(request.clientId, this.service.connect(scope));
          return this.success(request.requestId, { connected: true });
        }
        case 'service.disconnect': {
          if (!request.clientId) throw new Error('DataService client ID is required');
          this.clients.get(request.clientId)?.disconnect();
          this.clients.delete(request.clientId);
          return this.success(request.requestId, { disconnected: true });
        }
        case 'client.call': {
          if (!request.clientId) throw new Error('DataService client ID is required');
          const client = this.clients.get(request.clientId);
          if (!client) throw new Error('DataService client is not connected');
          const call = request.params as ClientCall;
          if (!call || !CLIENT_METHODS.has(call.method)) throw new Error(`DataService method is not allowed: ${call?.method}`);
          const method = (client as unknown as Record<string, unknown>)[call.method];
          if (typeof method !== 'function') throw new Error(`DataService method is unavailable: ${call.method}`);
          const result = await Reflect.apply(method, client, call.args ?? []);
          return this.success(request.requestId, result);
        }
        case 'service.shutdown': {
          await this.close();
          return this.success(request.requestId, { closed: true });
        }
      }
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? 'DATA_SERVICE_ERROR')
        : 'DATA_SERVICE_ERROR';
      return this.failure(request.requestId, code, error instanceof Error ? error.message : String(error));
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) client.disconnect();
    this.clients.clear();
    await this.service.close();
  }

  private success(requestId: string, result: unknown): DataServiceRpcMessage {
    return { protocol: DATA_SERVICE_RPC_PROTOCOL, type: 'response', requestId, ok: true, result };
  }

  private failure(requestId: string, code: string, message: string): DataServiceRpcMessage {
    return { protocol: DATA_SERVICE_RPC_PROTOCOL, type: 'response', requestId, ok: false, error: { code, message } };
  }
}
