import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
  AdmitRunInput,
  BranchConversationInput,
  CommitTerminalRunInput,
  ConversationId,
  ConversationQueryFilters,
  KernelContextSnapshotV1,
  RunId,
} from '@shared/conversations/contracts';
import type { KernelEventEnvelopeV1, KernelGeneration, KernelId } from '@shared/kernels/contracts';
import type {
  CanonicalCronAdmission,
  CanonicalCronJob,
  CanonicalCronRun,
  SchedulerLeaderLease,
  SchedulerLeaderLeaseAcquireResult,
} from '@shared/domains/cron';
import type { CanonicalProviderAccount, KernelProviderDefault } from '@shared/domains/providers';
import type { CanonicalAgent, KernelAgentDefault } from '@shared/domains/agents';
import type { CanonicalSkill } from '@shared/domains/skills';
import type { UsageQuery } from '@shared/domains/usage';
import type {
  CanonicalChannelAccount,
  CanonicalChannelBinding,
  CanonicalChannelDeliveryAttempt,
  CanonicalChannelMessage,
  ChannelMessageAdmissionInput,
  ChannelMessageAdmissionResult,
  ChannelMessageStatus,
  ChannelOwnerLease,
  ChannelOwnerLeaseAcquireResult,
} from '@shared/domains/channels';
import type {
  KernelActivationHistoryRecord,
  KernelCatalogStateRecord,
  KernelInstallationRecord,
  KernelRuntimeVersionRecord,
} from '@shared/kernels/package-manager';
import {
  ClawXDataStore,
  type ConversationExport,
  type ConversationPage,
  type ConversationSummary,
  type CreateConversationInput,
  type DataStoreFaultInjector,
} from './clawx-data-store';
import { ClawXBlobStore, type StoredBlob } from './clawx-blob-store';

export type DataServiceClientScope =
  | { role: 'main' }
  | { role: 'kernel'; kernelId: KernelId; generation: KernelGeneration };

type RegisteredClient = DataServiceClientScope & { clientId: string };

export class ClawXDataService {
  private readonly store: ClawXDataStore;
  private readonly blobs: ClawXBlobStore;
  private readonly clients = new Map<string, RegisteredClient>();
  private operationTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(databasePath: string, faults?: DataStoreFaultInjector, blobRoot = join(dirname(databasePath), 'blobs')) {
    this.store = new ClawXDataStore(databasePath, faults);
    this.blobs = new ClawXBlobStore(blobRoot);
  }

  connect(scope: DataServiceClientScope): ClawXDataClient {
    const token = randomUUID();
    this.clients.set(token, { ...scope, clientId: randomUUID() });
    return new ClawXDataClient(this, token);
  }

  disconnect(token: string): void {
    this.clients.delete(token);
  }

  private client(token: string): RegisteredClient {
    const client = this.clients.get(token);
    if (!client) throw new Error('DataService client is not authenticated');
    return client;
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  createConversation(token: string, input: CreateConversationInput): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can create conversations'));
    return this.enqueue(() => this.store.createConversation(input));
  }

  branchConversation(token: string, input: BranchConversationInput): Promise<ConversationSummary> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can branch conversations'));
    return this.enqueue(() => this.store.branchConversation(input));
  }

  getConversation(token: string, id: ConversationId): Promise<ConversationSummary | undefined> {
    this.client(token);
    return this.enqueue(() => this.store.getConversation(id));
  }

  listConversations(
    token: string,
    input: ConversationQueryFilters & { limit?: number; cursor?: string } = {},
  ): Promise<ConversationPage> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can list conversations'));
    return this.enqueue(() => this.store.listConversations(input));
  }

  searchConversations(
    token: string,
    query: string,
    limit?: number,
    filters: ConversationQueryFilters = {},
  ): Promise<ConversationSummary[]> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can search conversations'));
    return this.enqueue(() => this.store.searchConversations(query, limit, filters));
  }

  renameConversation(token: string, id: ConversationId, title: string, updatedAt: string): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can rename conversations'));
    return this.enqueue(() => this.store.renameConversation(id, title, updatedAt));
  }

  pinConversation(token: string, id: ConversationId, pinnedAt: string | undefined, updatedAt: string): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can pin conversations'));
    return this.enqueue(() => this.store.pinConversation(id, pinnedAt, updatedAt));
  }

  deleteConversation(token: string, id: ConversationId, deletedAt: string, hard = false): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can delete conversations'));
    return this.enqueue(() => {
      this.store.deleteConversation(id, deletedAt, hard);
      if (hard) this.collectUnreferencedBlobs();
    });
  }

  exportConversation(token: string, id: ConversationId): Promise<ConversationExport> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can export conversations'));
    return this.enqueue(() => this.store.exportConversation(id));
  }

  admitRun(token: string, input: AdmitRunInput): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can admit runs'));
    return this.enqueue(() => this.store.admitRun(input));
  }

  markRunStarted(token: string, runId: RunId, startedAt: string): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'kernel') return Promise.reject(new Error('Only a kernel can start a run'));
    return this.enqueue(() => this.store.markRunStarted(runId, client.kernelId, client.generation, startedAt));
  }

  appendEvents(token: string, events: KernelEventEnvelopeV1[]): Promise<{ inserted: number; duplicates: number }> {
    const client = this.client(token);
    if (client.role !== 'kernel') return Promise.reject(new Error('Only a kernel can append run events'));
    for (const event of events) {
      if (event.kernelId !== client.kernelId || event.generation !== client.generation) {
        return Promise.reject(new Error('Event is outside the authenticated kernel generation scope'));
      }
    }
    return this.enqueue(() => this.store.appendEvents(events));
  }

  commitTerminalRun(token: string, input: CommitTerminalRunInput): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'kernel') return Promise.reject(new Error('Only a kernel can commit a terminal run'));
    if (input.kernelId !== client.kernelId || input.generation !== client.generation) {
      return Promise.reject(new Error('Terminal commit is outside the authenticated kernel generation scope'));
    }
    return this.enqueue(() => this.store.commitTerminalRun(input));
  }

  compileContext(token: string, input: {
    conversationId: ConversationId;
    runId: RunId;
    maxBlocks?: number;
    maxTextCharacters?: number;
  }): Promise<KernelContextSnapshotV1> {
    const client = this.client(token);
    if (client.role !== 'kernel') return Promise.reject(new Error('Only a kernel can compile runtime context'));
    return this.enqueue(() => this.store.compileContext({ ...input, kernelId: client.kernelId }));
  }

  appendUsage(token: string, input: {
    id: string;
    runId: RunId;
    eventKey: string;
    providerId?: string;
    modelId?: string;
    requestId?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    cost?: number;
    currency?: string;
    source?: 'runtime-event' | 'provider-response';
    costUsd?: number;
    recordedAt: string;
  }): Promise<{ inserted: boolean }> {
    const client = this.client(token);
    if (client.role !== 'kernel') return Promise.reject(new Error('Only a kernel can append usage'));
    return this.enqueue(() => this.store.appendUsage({ ...input, kernelId: client.kernelId }));
  }

  listUsage(token: string, input: UsageQuery): Promise<Array<Record<string, unknown>>> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query usage'));
    return this.enqueue(() => this.store.listUsage(input));
  }

  putCronJob(token: string, input: CanonicalCronJob & { nextRunAt?: string }): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can write Cron jobs'));
    return this.enqueue(() => this.store.putCronJob(input));
  }

  getCronJob(token: string, id: string): Promise<(CanonicalCronJob & { nextRunAt?: string }) | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Cron jobs'));
    return this.enqueue(() => this.store.getCronJob(id));
  }

  listCronJobs(token: string): Promise<Array<CanonicalCronJob & { nextRunAt?: string }>> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Cron jobs'));
    return this.enqueue(() => this.store.listCronJobs());
  }

  deleteCronJob(token: string, id: string): Promise<boolean> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can delete Cron jobs'));
    return this.enqueue(() => this.store.deleteCronJob(id));
  }

  admitCron(token: string, input: CanonicalCronAdmission): Promise<{ inserted: boolean; admission: CanonicalCronAdmission }> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can admit Cron executions'));
    return this.enqueue(() => this.store.admitCron(input));
  }

  admitCronExecution(token: string, input: {
    admission: CanonicalCronAdmission;
    run: CanonicalCronRun;
  }): Promise<{ inserted: boolean; admission: CanonicalCronAdmission; run?: CanonicalCronRun }> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can admit Cron executions'));
    return this.enqueue(() => this.store.admitCronExecution(input));
  }

  putCronRun(token: string, input: CanonicalCronRun): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can write Cron runs'));
    return this.enqueue(() => this.store.putCronRun(input));
  }

  listCronRuns(token: string, jobId: string, limit?: number): Promise<Array<CanonicalCronRun & { scheduledFor: string }>> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Cron runs'));
    return this.enqueue(() => this.store.listCronRuns(jobId, limit));
  }

  getCronRun(token: string, id: string): Promise<CanonicalCronRun | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Cron runs'));
    return this.enqueue(() => this.store.getCronRun(id));
  }

  acquireSchedulerLease(
    token: string,
    input: SchedulerLeaderLease & { now: string },
  ): Promise<SchedulerLeaderLeaseAcquireResult> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can acquire Scheduler leases'));
    return this.enqueue(() => this.store.acquireSchedulerLease(input));
  }

  renewSchedulerLease(token: string, input: SchedulerLeaderLease & { now: string }): Promise<boolean> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can renew Scheduler leases'));
    return this.enqueue(() => this.store.renewSchedulerLease(input));
  }

  releaseSchedulerLease(token: string, input: {
    name: SchedulerLeaderLease['name'];
    ownerId: string;
  }): Promise<boolean> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can release Scheduler leases'));
    return this.enqueue(() => this.store.releaseSchedulerLease(input));
  }

  getSchedulerLease(
    token: string,
    name: SchedulerLeaderLease['name'],
    now: string,
  ): Promise<SchedulerLeaderLease | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Scheduler leases'));
    return this.enqueue(() => this.store.getSchedulerLease(name, now));
  }

  putBlob(token: string, input: { data: Uint8Array; mimeType: string; createdAt: string }): Promise<StoredBlob> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can admit blobs'));
    return this.enqueue(() => {
      const blob = this.blobs.put(input.data, input.mimeType);
      this.store.registerBlob({
        hash: blob.hash,
        byteLength: blob.byteLength,
        mimeType: blob.mimeType,
        createdAt: input.createdAt,
      });
      return blob;
    });
  }

  addBlobRef(token: string, input: {
    ownerType: string;
    ownerId: string;
    position?: number;
    blobHash: string;
    accessPolicy: unknown;
    createdAt: string;
  }): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can add blob references'));
    return this.enqueue(() => this.store.addBlobRef(input));
  }

  createAttachmentGrant(token: string, input: {
    id: string;
    blobHash: string;
    runId: RunId;
    kernelId: KernelId;
    generation: number;
    expiresAt: string;
    createdAt: string;
  }): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can grant attachment access'));
    return this.enqueue(() => this.store.createAttachmentGrant(input));
  }

  readBlob(token: string, input: {
    grantId: string;
    blobHash: string;
    runId: RunId;
    now: string;
  }): Promise<Uint8Array> {
    const client = this.client(token);
    if (client.role !== 'kernel') return Promise.reject(new Error('Only a kernel can consume attachment grants'));
    return this.enqueue(() => {
      const allowed = this.store.validateAttachmentGrant({
        id: input.grantId,
        blobHash: input.blobHash,
        runId: input.runId,
        kernelId: client.kernelId,
        generation: client.generation,
        now: input.now,
      });
      if (!allowed) throw new Error('Attachment grant is invalid, expired, revoked, or outside kernel scope');
      return this.blobs.readVerified(input.blobHash);
    });
  }

  getConversationBlobMetadata(token: string, input: {
    conversationId: ConversationId;
    blobHash: string;
  }): Promise<{ mimeType: string; size: number } | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can inspect Conversation blobs'));
    return this.enqueue(() => this.store.getConversationBlobMetadata(input.conversationId, input.blobHash));
  }

  readConversationBlob(token: string, input: {
    conversationId: ConversationId;
    blobHash: string;
  }): Promise<{ data: Uint8Array; mimeType: string; size: number }> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can read Conversation blobs'));
    return this.enqueue(() => {
      const metadata = this.store.getConversationBlobMetadata(input.conversationId, input.blobHash);
      if (!metadata) throw new Error('Blob is not readable from this Conversation');
      return { data: this.blobs.readVerified(input.blobHash), ...metadata };
    });
  }

  garbageCollectBlobs(token: string): Promise<string[]> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can collect blobs'));
    return this.enqueue(() => this.collectUnreferencedBlobs());
  }

  private collectUnreferencedBlobs(): string[] {
    const hashes = this.store.listUnreferencedBlobHashes();
    for (const hash of hashes) {
      // Delete bytes first. If this fails, metadata remains and a later GC can
      // safely retry; metadata is never deleted while bytes may be referenced.
      this.blobs.remove(hash);
      this.store.deleteBlobMetadata(hash);
    }
    return hashes;
  }

  putChannelAccount(token: string, account: CanonicalChannelAccount): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can write Channel accounts'));
    return this.enqueue(() => this.store.putChannelAccount(account));
  }

  getChannelAccount(
    token: string,
    id: string,
    input: { includeDeleted?: boolean; now?: string } = {},
  ): Promise<CanonicalChannelAccount | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Channel accounts'));
    return this.enqueue(() => this.store.getChannelAccount(id, input));
  }

  listChannelAccounts(
    token: string,
    input: { includeDeleted?: boolean; now?: string } = {},
  ): Promise<CanonicalChannelAccount[]> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Channel accounts'));
    return this.enqueue(() => this.store.listChannelAccounts(input));
  }

  deleteChannelAccount(token: string, id: string, deletedAt: string): Promise<boolean> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can delete Channel accounts'));
    return this.enqueue(() => this.store.deleteChannelAccount(id, deletedAt));
  }

  putChannelBinding(token: string, binding: CanonicalChannelBinding): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can write Channel bindings'));
    return this.enqueue(() => this.store.putChannelBinding(binding));
  }

  getChannelBinding(token: string, accountId: string, targetId = '*'): Promise<CanonicalChannelBinding | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Channel bindings'));
    return this.enqueue(() => this.store.getChannelBinding(accountId, targetId));
  }

  resolveChannelBinding(token: string, accountId: string, targetId: string): Promise<CanonicalChannelBinding | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can resolve Channel bindings'));
    return this.enqueue(() => this.store.resolveChannelBinding(accountId, targetId));
  }

  listChannelBindings(token: string, accountId?: string): Promise<CanonicalChannelBinding[]> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Channel bindings'));
    return this.enqueue(() => this.store.listChannelBindings(accountId));
  }

  deleteChannelBinding(token: string, accountId: string, targetId = '*'): Promise<boolean> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can delete Channel bindings'));
    return this.enqueue(() => this.store.deleteChannelBinding(accountId, targetId));
  }

  acquireChannelOwnerLease(
    token: string,
    input: ChannelOwnerLease & { now: string },
  ): Promise<ChannelOwnerLeaseAcquireResult> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can acquire Channel owner leases'));
    return this.enqueue(() => this.store.acquireChannelOwnerLease(input));
  }

  renewChannelOwnerLease(token: string, input: ChannelOwnerLease & { now: string }): Promise<boolean> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can renew Channel owner leases'));
    return this.enqueue(() => this.store.renewChannelOwnerLease(input));
  }

  releaseChannelOwnerLease(token: string, input: {
    accountId: string;
    ownerId: string;
    kernelId: KernelId;
    generation: number;
  }): Promise<boolean> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can release Channel owner leases'));
    return this.enqueue(() => this.store.releaseChannelOwnerLease(input));
  }

  getChannelOwnerLease(token: string, accountId: string, now: string): Promise<ChannelOwnerLease | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Channel owner leases'));
    return this.enqueue(() => this.store.getChannelOwnerLease(accountId, now));
  }

  admitChannelMessage(token: string, input: ChannelMessageAdmissionInput): Promise<ChannelMessageAdmissionResult> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can admit Channel messages'));
    return this.enqueue(() => this.store.admitChannelMessage(input));
  }

  updateChannelMessage(token: string, input: {
    id: string;
    status: ChannelMessageStatus;
    updatedAt: string;
    turnId?: string;
    runId?: string;
  }): Promise<boolean> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can update Channel messages'));
    return this.enqueue(() => this.store.updateChannelMessage(input));
  }

  getChannelMessage(token: string, id: string): Promise<CanonicalChannelMessage | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Channel messages'));
    return this.enqueue(() => this.store.getChannelMessage(id));
  }

  listChannelMessages(token: string, input: {
    accountId?: string;
    conversationId?: string;
    direction?: CanonicalChannelMessage['direction'];
    status?: ChannelMessageStatus;
    limit?: number;
  } = {}): Promise<CanonicalChannelMessage[]> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Channel messages'));
    return this.enqueue(() => this.store.listChannelMessages(input));
  }

  listPendingChannelDeliveries(token: string, limit?: number): Promise<CanonicalChannelMessage[]> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Channel deliveries'));
    return this.enqueue(() => this.store.listPendingChannelDeliveries(limit));
  }

  recordChannelDeliveryAttempt(token: string, input: CanonicalChannelDeliveryAttempt): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can record Channel deliveries'));
    return this.enqueue(() => this.store.recordChannelDeliveryAttempt(input));
  }

  listChannelDeliveryAttempts(token: string, messageId: string): Promise<CanonicalChannelDeliveryAttempt[]> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Channel delivery attempts'));
    return this.enqueue(() => this.store.listChannelDeliveryAttempts(messageId));
  }

  putSkill(token: string, skill: CanonicalSkill): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can write Skills'));
    return this.enqueue(() => this.store.putSkill(skill));
  }

  getSkill(token: string, id: string, includeDeleted = false): Promise<CanonicalSkill | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Skills'));
    return this.enqueue(() => this.store.getSkill(id, includeDeleted));
  }

  listSkills(token: string, includeDeleted = false): Promise<CanonicalSkill[]> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Skills'));
    return this.enqueue(() => this.store.listSkills(includeDeleted));
  }

  deleteSkill(token: string, id: string, deletedAt: string): Promise<boolean> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can delete Skills'));
    return this.enqueue(() => this.store.deleteSkill(id, deletedAt));
  }

  putAgent(token: string, agent: CanonicalAgent): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can write Agents'));
    return this.enqueue(() => this.store.putAgent(agent));
  }

  getAgent(token: string, id: string, includeDeleted = false): Promise<CanonicalAgent | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Agents'));
    return this.enqueue(() => this.store.getAgent(id, includeDeleted));
  }

  listAgents(token: string, includeDeleted = false): Promise<CanonicalAgent[]> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Agents'));
    return this.enqueue(() => this.store.listAgents(includeDeleted));
  }

  deleteAgent(token: string, id: string, deletedAt: string): Promise<boolean> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can delete Agents'));
    return this.enqueue(() => this.store.deleteAgent(id, deletedAt));
  }

  setAgentDefault(token: string, input: KernelAgentDefault): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can set Agent defaults'));
    return this.enqueue(() => this.store.setAgentDefault(input));
  }

  clearAgentDefault(token: string, kernelId: KernelId): Promise<boolean> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can clear Agent defaults'));
    return this.enqueue(() => this.store.clearAgentDefault(kernelId));
  }

  getAgentDefault(token: string, kernelId: KernelId): Promise<KernelAgentDefault | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Agent defaults'));
    return this.enqueue(() => this.store.getAgentDefault(kernelId));
  }

  listAgentDefaults(token: string): Promise<KernelAgentDefault[]> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Agent defaults'));
    return this.enqueue(() => this.store.listAgentDefaults());
  }

  putProvider(token: string, account: CanonicalProviderAccount): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can write Provider accounts'));
    return this.enqueue(() => this.store.putProvider(account));
  }

  getProvider(token: string, id: string): Promise<CanonicalProviderAccount | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Provider accounts'));
    return this.enqueue(() => this.store.getProvider(id));
  }

  listProviders(token: string): Promise<CanonicalProviderAccount[]> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Provider accounts'));
    return this.enqueue(() => this.store.listProviders());
  }

  deleteProvider(token: string, id: string): Promise<boolean> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can delete Provider accounts'));
    return this.enqueue(() => this.store.deleteProvider(id));
  }

  setProviderDefault(token: string, input: KernelProviderDefault): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can set Provider defaults'));
    return this.enqueue(() => this.store.setProviderDefault(input));
  }

  clearProviderDefault(token: string, kernelId: KernelId): Promise<boolean> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can clear Provider defaults'));
    return this.enqueue(() => this.store.clearProviderDefault(kernelId));
  }

  getProviderDefault(token: string, kernelId: KernelId): Promise<KernelProviderDefault | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Provider defaults'));
    return this.enqueue(() => this.store.getProviderDefault(kernelId));
  }

  listProviderDefaults(token: string): Promise<KernelProviderDefault[]> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query Provider defaults'));
    return this.enqueue(() => this.store.listProviderDefaults());
  }

  putOperation(token: string, input: {
    id: string;
    kind: string;
    targetType: string;
    targetId: string;
    desiredState: unknown;
    createdAt: string;
  }): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can create operations'));
    return this.enqueue(() => this.store.putOperation(input));
  }

  completeOperation(token: string, input: { id: string; ok: boolean; error?: string; updatedAt: string }): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can complete operations'));
    return this.enqueue(() => this.store.completeOperation(input));
  }

  upsertProjection(token: string, input: {
    entityType: string;
    entityId: string;
    kernelId: KernelId;
    desiredVersion: number;
    appliedVersion?: number;
    status: string;
    nativeId?: string;
    error?: string;
    updatedAt: string;
  }): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can reconcile projections'));
    return this.enqueue(() => this.store.upsertProjection(input));
  }

  deleteProjection(token: string, entityType: string, entityId: string, kernelId: KernelId): Promise<boolean> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can reconcile projections'));
    return this.enqueue(() => this.store.deleteProjection(entityType, entityId, kernelId));
  }

  listProjections(token: string, entityType: string, entityId: string): Promise<Array<Record<string, unknown>>> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query projections'));
    return this.enqueue(() => this.store.listProjections(entityType, entityId));
  }

  getKernelCatalogState(token: string, channel: KernelCatalogStateRecord['channel']): Promise<KernelCatalogStateRecord | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query kernel catalog state'));
    return this.enqueue(() => this.store.getKernelCatalogState(channel));
  }

  putKernelCatalogState(token: string, input: KernelCatalogStateRecord): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can update kernel catalog state'));
    return this.enqueue(() => this.store.putKernelCatalogState(input));
  }

  getKernelInstallation(token: string, kernelId: KernelId): Promise<KernelInstallationRecord | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query kernel installations'));
    return this.enqueue(() => this.store.getKernelInstallation(kernelId));
  }

  listKernelInstallations(token: string): Promise<KernelInstallationRecord[]> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query kernel installations'));
    return this.enqueue(() => this.store.listKernelInstallations());
  }

  putKernelInstallation(token: string, input: KernelInstallationRecord): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can update kernel installations'));
    return this.enqueue(() => this.store.putKernelInstallation(input));
  }

  upsertKernelRuntimeVersion(token: string, input: KernelRuntimeVersionRecord): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can update kernel runtime versions'));
    return this.enqueue(() => this.store.upsertKernelRuntimeVersion(input));
  }

  getKernelRuntimeVersion(token: string, kernelId: KernelId, artifactVersion: string): Promise<KernelRuntimeVersionRecord | undefined> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query kernel runtime versions'));
    return this.enqueue(() => this.store.getKernelRuntimeVersion(kernelId, artifactVersion));
  }

  listKernelRuntimeVersions(token: string, kernelId?: KernelId): Promise<KernelRuntimeVersionRecord[]> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query kernel runtime versions'));
    return this.enqueue(() => this.store.listKernelRuntimeVersions(kernelId));
  }

  removeKernelRuntimeVersion(token: string, kernelId: KernelId, artifactVersion: string): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can remove kernel runtime versions'));
    return this.enqueue(() => this.store.removeKernelRuntimeVersion(kernelId, artifactVersion));
  }

  commitKernelActivation(token: string, input: {
    kernelId: KernelId;
    activeVersion: string;
    lastKnownGoodVersion: string;
    expectedActiveVersion: string | null;
    reason: KernelActivationHistoryRecord['reason'];
    manifest: KernelInstallationRecord['manifest'];
    updatedAt: string;
  }): Promise<KernelInstallationRecord> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can activate kernel versions'));
    return this.enqueue(() => this.store.commitKernelActivation(input));
  }

  listKernelActivationHistory(token: string, kernelId: KernelId, limit?: number): Promise<KernelActivationHistoryRecord[]> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can query kernel activation history'));
    return this.enqueue(() => this.store.listKernelActivationHistory(kernelId, limit));
  }

  putCheckpoint(token: string, input: {
    runId: RunId;
    codec: string;
    schemaVersion: number;
    checkpoint: unknown;
    createdAt: string;
  }): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'kernel') return Promise.reject(new Error('Only a kernel can write checkpoints'));
    return this.enqueue(() => this.store.putCheckpoint({ ...input, kernelId: client.kernelId }));
  }

  getCheckpoint(token: string, input: {
    runId: RunId;
    codec: string;
    schemaVersion: number;
  }): Promise<unknown | undefined> {
    const client = this.client(token);
    if (client.role !== 'kernel') return Promise.reject(new Error('Only a kernel can read checkpoints'));
    return this.enqueue(() => this.store.getCheckpoint({ ...input, kernelId: client.kernelId }));
  }

  getLatestConversationCheckpoint(token: string, input: {
    conversationId: ConversationId;
    codec: string;
    schemaVersion: number;
    beforeRunId?: RunId;
  }): Promise<{ runId: RunId; checkpoint: unknown; createdAt: string } | undefined> {
    const client = this.client(token);
    if (client.role !== 'kernel') return Promise.reject(new Error('Only a kernel can read checkpoints'));
    return this.enqueue(() => this.store.getLatestConversationCheckpoint({
      ...input,
      kernelId: client.kernelId,
    }));
  }

  listRunEvents(token: string, runId: RunId): Promise<Array<{ eventSeq: number; kind: string; payload: unknown }>> {
    this.client(token);
    return this.enqueue(() => this.store.listRunEvents(runId));
  }

  getRunArtifacts(token: string, runId: RunId): Promise<{
    tools: Array<Record<string, unknown>>;
    permissions: Array<Record<string, unknown>>;
    usage: Array<Record<string, unknown>>;
  }> {
    this.client(token);
    return this.enqueue(() => this.store.getRunArtifacts(runId));
  }

  integrityCheck(token: string): Promise<string> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can run integrity checks'));
    return this.enqueue(() => this.store.integrityCheck());
  }

  backupTo(token: string, path: string): Promise<void> {
    const client = this.client(token);
    if (client.role !== 'main') return Promise.reject(new Error('Only Main can create backups'));
    return this.enqueue(() => this.store.backupTo(path));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.operationTail;
    this.clients.clear();
    this.store.close();
  }
}

export class ClawXDataClient {
  constructor(
    private readonly service: ClawXDataService,
    private readonly token: string,
  ) {}

  createConversation(input: CreateConversationInput): Promise<void> {
    return this.service.createConversation(this.token, input);
  }

  branchConversation(input: BranchConversationInput): Promise<ConversationSummary> {
    return this.service.branchConversation(this.token, input);
  }

  getConversation(id: ConversationId): Promise<ConversationSummary | undefined> {
    return this.service.getConversation(this.token, id);
  }

  listConversations(
    input: ConversationQueryFilters & { limit?: number; cursor?: string } = {},
  ): Promise<ConversationPage> {
    return this.service.listConversations(this.token, input);
  }

  searchConversations(
    query: string,
    limit?: number,
    filters: ConversationQueryFilters = {},
  ): Promise<ConversationSummary[]> {
    return this.service.searchConversations(this.token, query, limit, filters);
  }

  renameConversation(id: ConversationId, title: string, updatedAt: string): Promise<void> {
    return this.service.renameConversation(this.token, id, title, updatedAt);
  }

  pinConversation(id: ConversationId, pinnedAt: string | undefined, updatedAt: string): Promise<void> {
    return this.service.pinConversation(this.token, id, pinnedAt, updatedAt);
  }

  deleteConversation(id: ConversationId, deletedAt: string, hard = false): Promise<void> {
    return this.service.deleteConversation(this.token, id, deletedAt, hard);
  }

  exportConversation(id: ConversationId): Promise<ConversationExport> {
    return this.service.exportConversation(this.token, id);
  }

  admitRun(input: AdmitRunInput): Promise<void> {
    return this.service.admitRun(this.token, input);
  }

  markRunStarted(runId: RunId, startedAt: string): Promise<void> {
    return this.service.markRunStarted(this.token, runId, startedAt);
  }

  appendEvents(events: KernelEventEnvelopeV1[]): Promise<{ inserted: number; duplicates: number }> {
    return this.service.appendEvents(this.token, events);
  }

  commitTerminalRun(input: CommitTerminalRunInput): Promise<void> {
    return this.service.commitTerminalRun(this.token, input);
  }

  compileContext(input: {
    conversationId: ConversationId;
    runId: RunId;
    maxBlocks?: number;
    maxTextCharacters?: number;
  }): Promise<KernelContextSnapshotV1> {
    return this.service.compileContext(this.token, input);
  }

  appendUsage(input: {
    id: string;
    runId: RunId;
    eventKey: string;
    providerId?: string;
    modelId?: string;
    requestId?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    cost?: number;
    currency?: string;
    source?: 'runtime-event' | 'provider-response';
    costUsd?: number;
    recordedAt: string;
  }): Promise<{ inserted: boolean }> {
    return this.service.appendUsage(this.token, input);
  }

  listUsage(input: UsageQuery): Promise<Array<Record<string, unknown>>> {
    return this.service.listUsage(this.token, input);
  }

  putCronJob(input: CanonicalCronJob & { nextRunAt?: string }): Promise<void> {
    return this.service.putCronJob(this.token, input);
  }

  getCronJob(id: string): Promise<(CanonicalCronJob & { nextRunAt?: string }) | undefined> {
    return this.service.getCronJob(this.token, id);
  }

  listCronJobs(): Promise<Array<CanonicalCronJob & { nextRunAt?: string }>> {
    return this.service.listCronJobs(this.token);
  }

  deleteCronJob(id: string): Promise<boolean> {
    return this.service.deleteCronJob(this.token, id);
  }

  admitCron(input: CanonicalCronAdmission): Promise<{ inserted: boolean; admission: CanonicalCronAdmission }> {
    return this.service.admitCron(this.token, input);
  }

  admitCronExecution(input: {
    admission: CanonicalCronAdmission;
    run: CanonicalCronRun;
  }): Promise<{ inserted: boolean; admission: CanonicalCronAdmission; run?: CanonicalCronRun }> {
    return this.service.admitCronExecution(this.token, input);
  }

  putCronRun(input: CanonicalCronRun): Promise<void> {
    return this.service.putCronRun(this.token, input);
  }

  listCronRuns(jobId: string, limit?: number): Promise<Array<CanonicalCronRun & { scheduledFor: string }>> {
    return this.service.listCronRuns(this.token, jobId, limit);
  }

  getCronRun(id: string): Promise<CanonicalCronRun | undefined> {
    return this.service.getCronRun(this.token, id);
  }

  acquireSchedulerLease(
    input: SchedulerLeaderLease & { now: string },
  ): Promise<SchedulerLeaderLeaseAcquireResult> {
    return this.service.acquireSchedulerLease(this.token, input);
  }

  renewSchedulerLease(input: SchedulerLeaderLease & { now: string }): Promise<boolean> {
    return this.service.renewSchedulerLease(this.token, input);
  }

  releaseSchedulerLease(input: {
    name: SchedulerLeaderLease['name'];
    ownerId: string;
  }): Promise<boolean> {
    return this.service.releaseSchedulerLease(this.token, input);
  }

  getSchedulerLease(
    name: SchedulerLeaderLease['name'],
    now: string,
  ): Promise<SchedulerLeaderLease | undefined> {
    return this.service.getSchedulerLease(this.token, name, now);
  }

  putBlob(input: { data: Uint8Array; mimeType: string; createdAt: string }): Promise<StoredBlob> {
    return this.service.putBlob(this.token, input);
  }

  addBlobRef(input: {
    ownerType: string;
    ownerId: string;
    position?: number;
    blobHash: string;
    accessPolicy: unknown;
    createdAt: string;
  }): Promise<void> {
    return this.service.addBlobRef(this.token, input);
  }

  createAttachmentGrant(input: {
    id: string;
    blobHash: string;
    runId: RunId;
    kernelId: KernelId;
    generation: number;
    expiresAt: string;
    createdAt: string;
  }): Promise<void> {
    return this.service.createAttachmentGrant(this.token, input);
  }

  readBlob(input: { grantId: string; blobHash: string; runId: RunId; now: string }): Promise<Uint8Array> {
    return this.service.readBlob(this.token, input);
  }

  getConversationBlobMetadata(input: {
    conversationId: ConversationId;
    blobHash: string;
  }): Promise<{ mimeType: string; size: number } | undefined> {
    return this.service.getConversationBlobMetadata(this.token, input);
  }

  readConversationBlob(input: {
    conversationId: ConversationId;
    blobHash: string;
  }): Promise<{ data: Uint8Array; mimeType: string; size: number }> {
    return this.service.readConversationBlob(this.token, input);
  }

  garbageCollectBlobs(): Promise<string[]> {
    return this.service.garbageCollectBlobs(this.token);
  }

  putChannelAccount(account: CanonicalChannelAccount): Promise<void> {
    return this.service.putChannelAccount(this.token, account);
  }

  getChannelAccount(
    id: string,
    input: { includeDeleted?: boolean; now?: string } = {},
  ): Promise<CanonicalChannelAccount | undefined> {
    return this.service.getChannelAccount(this.token, id, input);
  }

  listChannelAccounts(
    input: { includeDeleted?: boolean; now?: string } = {},
  ): Promise<CanonicalChannelAccount[]> {
    return this.service.listChannelAccounts(this.token, input);
  }

  deleteChannelAccount(id: string, deletedAt: string): Promise<boolean> {
    return this.service.deleteChannelAccount(this.token, id, deletedAt);
  }

  putChannelBinding(binding: CanonicalChannelBinding): Promise<void> {
    return this.service.putChannelBinding(this.token, binding);
  }

  getChannelBinding(accountId: string, targetId = '*'): Promise<CanonicalChannelBinding | undefined> {
    return this.service.getChannelBinding(this.token, accountId, targetId);
  }

  resolveChannelBinding(accountId: string, targetId: string): Promise<CanonicalChannelBinding | undefined> {
    return this.service.resolveChannelBinding(this.token, accountId, targetId);
  }

  listChannelBindings(accountId?: string): Promise<CanonicalChannelBinding[]> {
    return this.service.listChannelBindings(this.token, accountId);
  }

  deleteChannelBinding(accountId: string, targetId = '*'): Promise<boolean> {
    return this.service.deleteChannelBinding(this.token, accountId, targetId);
  }

  acquireChannelOwnerLease(input: ChannelOwnerLease & { now: string }): Promise<ChannelOwnerLeaseAcquireResult> {
    return this.service.acquireChannelOwnerLease(this.token, input);
  }

  renewChannelOwnerLease(input: ChannelOwnerLease & { now: string }): Promise<boolean> {
    return this.service.renewChannelOwnerLease(this.token, input);
  }

  releaseChannelOwnerLease(input: {
    accountId: string;
    ownerId: string;
    kernelId: KernelId;
    generation: number;
  }): Promise<boolean> {
    return this.service.releaseChannelOwnerLease(this.token, input);
  }

  getChannelOwnerLease(accountId: string, now: string): Promise<ChannelOwnerLease | undefined> {
    return this.service.getChannelOwnerLease(this.token, accountId, now);
  }

  admitChannelMessage(input: ChannelMessageAdmissionInput): Promise<ChannelMessageAdmissionResult> {
    return this.service.admitChannelMessage(this.token, input);
  }

  updateChannelMessage(input: {
    id: string;
    status: ChannelMessageStatus;
    updatedAt: string;
    turnId?: string;
    runId?: string;
  }): Promise<boolean> {
    return this.service.updateChannelMessage(this.token, input);
  }

  getChannelMessage(id: string): Promise<CanonicalChannelMessage | undefined> {
    return this.service.getChannelMessage(this.token, id);
  }

  listChannelMessages(input: {
    accountId?: string;
    conversationId?: string;
    direction?: CanonicalChannelMessage['direction'];
    status?: ChannelMessageStatus;
    limit?: number;
  } = {}): Promise<CanonicalChannelMessage[]> {
    return this.service.listChannelMessages(this.token, input);
  }

  listPendingChannelDeliveries(limit?: number): Promise<CanonicalChannelMessage[]> {
    return this.service.listPendingChannelDeliveries(this.token, limit);
  }

  recordChannelDeliveryAttempt(input: CanonicalChannelDeliveryAttempt): Promise<void> {
    return this.service.recordChannelDeliveryAttempt(this.token, input);
  }

  listChannelDeliveryAttempts(messageId: string): Promise<CanonicalChannelDeliveryAttempt[]> {
    return this.service.listChannelDeliveryAttempts(this.token, messageId);
  }

  putSkill(skill: CanonicalSkill): Promise<void> {
    return this.service.putSkill(this.token, skill);
  }

  getSkill(id: string, includeDeleted = false): Promise<CanonicalSkill | undefined> {
    return this.service.getSkill(this.token, id, includeDeleted);
  }

  listSkills(includeDeleted = false): Promise<CanonicalSkill[]> {
    return this.service.listSkills(this.token, includeDeleted);
  }

  deleteSkill(id: string, deletedAt: string): Promise<boolean> {
    return this.service.deleteSkill(this.token, id, deletedAt);
  }

  putAgent(agent: CanonicalAgent): Promise<void> {
    return this.service.putAgent(this.token, agent);
  }

  getAgent(id: string, includeDeleted = false): Promise<CanonicalAgent | undefined> {
    return this.service.getAgent(this.token, id, includeDeleted);
  }

  listAgents(includeDeleted = false): Promise<CanonicalAgent[]> {
    return this.service.listAgents(this.token, includeDeleted);
  }

  deleteAgent(id: string, deletedAt: string): Promise<boolean> {
    return this.service.deleteAgent(this.token, id, deletedAt);
  }

  setAgentDefault(input: KernelAgentDefault): Promise<void> {
    return this.service.setAgentDefault(this.token, input);
  }

  clearAgentDefault(kernelId: KernelId): Promise<boolean> {
    return this.service.clearAgentDefault(this.token, kernelId);
  }

  getAgentDefault(kernelId: KernelId): Promise<KernelAgentDefault | undefined> {
    return this.service.getAgentDefault(this.token, kernelId);
  }

  listAgentDefaults(): Promise<KernelAgentDefault[]> {
    return this.service.listAgentDefaults(this.token);
  }

  putProvider(account: CanonicalProviderAccount): Promise<void> {
    return this.service.putProvider(this.token, account);
  }

  getProvider(id: string): Promise<CanonicalProviderAccount | undefined> {
    return this.service.getProvider(this.token, id);
  }

  listProviders(): Promise<CanonicalProviderAccount[]> {
    return this.service.listProviders(this.token);
  }

  deleteProvider(id: string): Promise<boolean> {
    return this.service.deleteProvider(this.token, id);
  }

  setProviderDefault(input: KernelProviderDefault): Promise<void> {
    return this.service.setProviderDefault(this.token, input);
  }

  clearProviderDefault(kernelId: KernelId): Promise<boolean> {
    return this.service.clearProviderDefault(this.token, kernelId);
  }

  getProviderDefault(kernelId: KernelId): Promise<KernelProviderDefault | undefined> {
    return this.service.getProviderDefault(this.token, kernelId);
  }

  listProviderDefaults(): Promise<KernelProviderDefault[]> {
    return this.service.listProviderDefaults(this.token);
  }

  putOperation(input: {
    id: string;
    kind: string;
    targetType: string;
    targetId: string;
    desiredState: unknown;
    createdAt: string;
  }): Promise<void> {
    return this.service.putOperation(this.token, input);
  }

  completeOperation(input: { id: string; ok: boolean; error?: string; updatedAt: string }): Promise<void> {
    return this.service.completeOperation(this.token, input);
  }

  upsertProjection(input: {
    entityType: string;
    entityId: string;
    kernelId: KernelId;
    desiredVersion: number;
    appliedVersion?: number;
    status: string;
    nativeId?: string;
    error?: string;
    updatedAt: string;
  }): Promise<void> {
    return this.service.upsertProjection(this.token, input);
  }

  deleteProjection(entityType: string, entityId: string, kernelId: KernelId): Promise<boolean> {
    return this.service.deleteProjection(this.token, entityType, entityId, kernelId);
  }

  listProjections(entityType: string, entityId: string): Promise<Array<Record<string, unknown>>> {
    return this.service.listProjections(this.token, entityType, entityId);
  }

  getKernelCatalogState(channel: KernelCatalogStateRecord['channel']): Promise<KernelCatalogStateRecord | undefined> {
    return this.service.getKernelCatalogState(this.token, channel);
  }

  putKernelCatalogState(input: KernelCatalogStateRecord): Promise<void> {
    return this.service.putKernelCatalogState(this.token, input);
  }

  getKernelInstallation(kernelId: KernelId): Promise<KernelInstallationRecord | undefined> {
    return this.service.getKernelInstallation(this.token, kernelId);
  }

  listKernelInstallations(): Promise<KernelInstallationRecord[]> {
    return this.service.listKernelInstallations(this.token);
  }

  putKernelInstallation(input: KernelInstallationRecord): Promise<void> {
    return this.service.putKernelInstallation(this.token, input);
  }

  upsertKernelRuntimeVersion(input: KernelRuntimeVersionRecord): Promise<void> {
    return this.service.upsertKernelRuntimeVersion(this.token, input);
  }

  getKernelRuntimeVersion(kernelId: KernelId, artifactVersion: string): Promise<KernelRuntimeVersionRecord | undefined> {
    return this.service.getKernelRuntimeVersion(this.token, kernelId, artifactVersion);
  }

  listKernelRuntimeVersions(kernelId?: KernelId): Promise<KernelRuntimeVersionRecord[]> {
    return this.service.listKernelRuntimeVersions(this.token, kernelId);
  }

  removeKernelRuntimeVersion(kernelId: KernelId, artifactVersion: string): Promise<void> {
    return this.service.removeKernelRuntimeVersion(this.token, kernelId, artifactVersion);
  }

  commitKernelActivation(input: {
    kernelId: KernelId;
    activeVersion: string;
    lastKnownGoodVersion: string;
    expectedActiveVersion: string | null;
    reason: KernelActivationHistoryRecord['reason'];
    manifest: KernelInstallationRecord['manifest'];
    updatedAt: string;
  }): Promise<KernelInstallationRecord> {
    return this.service.commitKernelActivation(this.token, input);
  }

  listKernelActivationHistory(kernelId: KernelId, limit?: number): Promise<KernelActivationHistoryRecord[]> {
    return this.service.listKernelActivationHistory(this.token, kernelId, limit);
  }

  putCheckpoint(input: { runId: RunId; codec: string; schemaVersion: number; checkpoint: unknown; createdAt: string }): Promise<void> {
    return this.service.putCheckpoint(this.token, input);
  }

  getCheckpoint(input: { runId: RunId; codec: string; schemaVersion: number }): Promise<unknown | undefined> {
    return this.service.getCheckpoint(this.token, input);
  }

  getLatestConversationCheckpoint(input: {
    conversationId: ConversationId;
    codec: string;
    schemaVersion: number;
    beforeRunId?: RunId;
  }): Promise<{ runId: RunId; checkpoint: unknown; createdAt: string } | undefined> {
    return this.service.getLatestConversationCheckpoint(this.token, input);
  }

  listRunEvents(runId: RunId): Promise<Array<{ eventSeq: number; kind: string; payload: unknown }>> {
    return this.service.listRunEvents(this.token, runId);
  }

  getRunArtifacts(runId: RunId): Promise<{
    tools: Array<Record<string, unknown>>;
    permissions: Array<Record<string, unknown>>;
    usage: Array<Record<string, unknown>>;
  }> {
    return this.service.getRunArtifacts(this.token, runId);
  }

  integrityCheck(): Promise<string> {
    return this.service.integrityCheck(this.token);
  }

  backupTo(path: string): Promise<void> {
    return this.service.backupTo(this.token, path);
  }

  disconnect(): void {
    this.service.disconnect(this.token);
  }
}
