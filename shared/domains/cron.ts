import type { ConversationId, RunId } from '../conversations/contracts';
import type { KernelId } from '../kernels/contracts';
import type { AgentId, CronJobId } from './identity';

export type CanonicalSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'interval'; everyMs: number; anchorAt?: string }
  | { kind: 'cron'; expression: string; timezone: string };

export type CronMisfirePolicy = 'skip' | 'run-once' | 'catch-up';
export type CronOverlapPolicy = 'skip' | 'queue' | 'replace';
export type CronConversationPolicy = 'reuse' | 'new-per-run' | 'new-per-day';
export type CronTriggerKind = 'scheduled' | 'manual' | 'misfire';

export type CanonicalCronDelivery = {
  accountId: string;
  targetId: string;
  mode?: 'announce';
  channel?: string;
};

export type CanonicalCronJob = {
  id: CronJobId;
  name: string;
  prompt: string;
  schedule: CanonicalSchedule;
  kernelId: KernelId;
  agentId: AgentId;
  conversationPolicy: CronConversationPolicy;
  conversationId?: ConversationId;
  delivery?: CanonicalCronDelivery;
  misfirePolicy: CronMisfirePolicy;
  overlapPolicy: CronOverlapPolicy;
  timeoutMs: number;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type CronAdmissionSnapshot = {
  jobUpdatedAt: string;
  kernelId: KernelId;
  agentId: AgentId;
  prompt: string;
  conversationPolicy: CronConversationPolicy;
  conversationId: ConversationId;
  delivery?: CanonicalCronDelivery;
  timeoutMs: number;
};

export type CanonicalCronAdmission = {
  id: string;
  jobId: CronJobId;
  scheduledFor: string;
  triggerKind: CronTriggerKind;
  snapshot: CronAdmissionSnapshot;
  admittedAt: string;
  runId?: RunId;
};

export type CanonicalCronRun = {
  id: string;
  admissionId: string;
  runId?: RunId;
  status: 'admitted' | 'running' | 'completed' | 'cancelled' | 'timed-out' | 'failed' | 'missed';
  startedAt?: string;
  completedAt?: string;
  error?: string;
  diagnostic?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  deliveryMessageId?: string;
};

export type SchedulerLeaderLease = {
  name: 'clawx-scheduler';
  ownerId: string;
  leaseExpiresAt: string;
  updatedAt: string;
};

export type SchedulerLeaderLeaseAcquireResult = {
  acquired: boolean;
  lease: SchedulerLeaderLease;
};
