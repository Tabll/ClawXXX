// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { KernelId } from '@shared/kernels/contracts';
import { verifyKernelDriverContract } from './driver-contract-kit';
import { FakeKernelDriver } from './fakes/fake-kernel-driver';

describe.each<KernelId>(['openclaw', 'deepseek-harness'])('KernelDriver contract: %s', kernelId => {
  it('passes the shared lifecycle, execution, identity, persistence, and control-plane contract', async () => {
    await verifyKernelDriverContract(kernelId, () => new FakeKernelDriver(kernelId));
  });

  it('fails a direct native history write instead of creating a fallback', () => {
    const driver = new FakeKernelDriver(kernelId);
    expect(() => driver.attemptNativeHistoryWrite(`/runtime/${kernelId}/sessions/native.jsonl`))
      .toThrow(/cannot open native durable history/);
    expect(driver.attemptedNativeHistoryPaths).toHaveLength(1);
  });
});
