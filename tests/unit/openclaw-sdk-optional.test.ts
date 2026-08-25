// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pathMocks = vi.hoisted(() => ({
  getOpenClawDir: vi.fn(),
  getOpenClawResolvedDir: vi.fn(),
}));

vi.mock('@electron/utils/paths', () => pathMocks);

describe('optional OpenClaw channel SDK boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    pathMocks.getOpenClawDir.mockReset().mockImplementation(() => {
      throw new Error('OpenClaw runtime is not installed or activated');
    });
    pathMocks.getOpenClawResolvedDir.mockReset().mockImplementation(() => {
      throw new Error('OpenClaw runtime is not installed or activated');
    });
  });

  it('imports and returns safe empty channel helpers when the kernel is absent', async () => {
    const sdk = await import('@electron/utils/openclaw-sdk');

    await expect(sdk.listDiscordDirectoryGroupsFromConfig({})).resolves.toEqual([]);
    await expect(sdk.listTelegramDirectoryPeersFromConfig({})).resolves.toEqual([]);
    await expect(sdk.listSlackDirectoryGroupsFromConfig({})).resolves.toEqual([]);
    expect(sdk.normalizeDiscordMessagingTarget('room')).toBeUndefined();
    expect(sdk.normalizeTelegramMessagingTarget('room')).toBeUndefined();
    expect(sdk.normalizeSlackMessagingTarget('room')).toBeUndefined();
    expect(sdk.normalizeWhatsAppMessagingTarget('room')).toBeUndefined();
  });

  it('retries runtime resolution after an earlier absence instead of caching the miss', async () => {
    const sdk = await import('@electron/utils/openclaw-sdk');
    expect(sdk.normalizeDiscordMessagingTarget('room')).toBeUndefined();

    pathMocks.getOpenClawResolvedDir.mockReturnValue('/runtime/openclaw');
    pathMocks.getOpenClawDir.mockReturnValue('/runtime/openclaw');
    expect(sdk.normalizeDiscordMessagingTarget('room')).toBeUndefined();
    expect(pathMocks.getOpenClawResolvedDir.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
