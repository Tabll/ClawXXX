import type { KernelId } from '@shared/kernels/contracts';

export type KernelAutoStartPolicies = Record<string, boolean>;

export type RuntimeLifecycleParticipant = {
  id: string;
  autoStart(policies: KernelAutoStartPolicies): Promise<void>;
  stop(deadlineMs: number): Promise<void>;
  forceTerminate(): Promise<void>;
};

export type SingleKernelLifecycleController = {
  kernelId: KernelId;
  start(): Promise<void>;
  stop(): Promise<void>;
  forceTerminate(): Promise<unknown>;
};

export function createSingleKernelLifecycleParticipant(
  controller: SingleKernelLifecycleController,
): RuntimeLifecycleParticipant {
  return {
    id: `kernel:${controller.kernelId}`,
    autoStart: async (policies) => {
      if (policies[controller.kernelId] === true) await controller.start();
    },
    stop: async () => controller.stop(),
    forceTerminate: async () => {
      await controller.forceTerminate();
    },
  };
}

/** Main-process startup and quit orchestration with no kernel singleton. */
export class RuntimeLifecycleCoordinator {
  private readonly participants = new Map<string, RuntimeLifecycleParticipant>();

  register(participant: RuntimeLifecycleParticipant): () => void {
    if (this.participants.has(participant.id)) {
      throw new Error(`Runtime lifecycle participant is already registered: ${participant.id}`);
    }
    this.participants.set(participant.id, participant);
    return () => {
      if (this.participants.get(participant.id) === participant) {
        this.participants.delete(participant.id);
      }
    };
  }

  async autoStart(policies: KernelAutoStartPolicies): Promise<Array<{ id: string; error: string }>> {
    const results = await Promise.allSettled(
      [...this.participants.values()].map(async participant => {
        await participant.autoStart(policies);
        return participant.id;
      }),
    );
    const failures: Array<{ id: string; error: string }> = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return;
      const participant = [...this.participants.values()][index];
      if (participant) failures.push({
        id: participant.id,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });
    return failures;
  }

  async stopAllForQuit(deadlineMs: number): Promise<{ timedOut: boolean }> {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
      throw new Error('Runtime shutdown deadline must be a positive integer');
    }
    const participants = [...this.participants.values()];
    const stopping = Promise.allSettled(participants.map(participant => participant.stop(deadlineMs)));
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), deadlineMs);
      timeout.unref?.();
    });
    const result = await Promise.race([stopping.then(() => 'stopped' as const), deadline]);
    if (timeout) clearTimeout(timeout);
    if (result === 'stopped') return { timedOut: false };
    await Promise.allSettled(participants.map(participant => participant.forceTerminate()));
    return { timedOut: true };
  }

  async forceTerminateAll(): Promise<void> {
    await Promise.allSettled(
      [...this.participants.values()].map(participant => participant.forceTerminate()),
    );
  }
}
