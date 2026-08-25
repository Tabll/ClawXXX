// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeMocks = vi.hoisted(() => ({
  getAllSettings: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock('@electron/utils/store', () => storeMocks);

import {
  getKernelAutoStartPolicies,
  setKernelAutoStartPolicy,
  synchronizeLegacyGatewayAutoStart,
} from '@electron/kernels/auto-start-policy';

describe('per-kernel auto-start policy migration', () => {
  beforeEach(() => {
    storeMocks.getAllSettings.mockReset();
    storeMocks.setSetting.mockReset();
    storeMocks.setSetting.mockResolvedValue(undefined);
  });

  it('inherits the legacy OpenClaw value while keeping future kernels independent', async () => {
    storeMocks.getAllSettings.mockResolvedValue({
      gatewayAutoStart: false,
      kernelAutoStartPolicies: { 'deepseek-harness': true, invalid: 'yes' },
    });
    await expect(getKernelAutoStartPolicies()).resolves.toEqual({
      openclaw: false,
      'deepseek-harness': true,
    });
  });

  it('persists OpenClaw to both keys during the compatibility window', async () => {
    storeMocks.getAllSettings.mockResolvedValue({
      gatewayAutoStart: false,
      kernelAutoStartPolicies: { 'deepseek-harness': true },
    });
    await setKernelAutoStartPolicy('openclaw', true);
    expect(storeMocks.setSetting).toHaveBeenNthCalledWith(1, 'kernelAutoStartPolicies', {
      openclaw: true,
      'deepseek-harness': true,
    });
    expect(storeMocks.setSetting).toHaveBeenNthCalledWith(2, 'gatewayAutoStart', true);
  });

  it('migrates writes from the legacy settings toggle without changing another kernel', async () => {
    storeMocks.getAllSettings.mockResolvedValue({
      gatewayAutoStart: true,
      kernelAutoStartPolicies: { openclaw: true, 'deepseek-harness': false },
    });
    await synchronizeLegacyGatewayAutoStart(false);
    expect(storeMocks.setSetting).toHaveBeenCalledWith('kernelAutoStartPolicies', {
      openclaw: false,
      'deepseek-harness': false,
    });
  });
});
