// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { collectLegacyChannelAccounts } from '@electron/channels/channel-migration';

describe('legacy Channel metadata migration', () => {
  it('retains disabled configured accounts but ignores empty control-only sections', () => {
    const result = collectLegacyChannelAccounts({
      channels: {
        telegram: {
          enabled: false,
          defaultAccount: 'secondary',
          accounts: {
            primary: { enabled: false, botToken: 'one' },
            secondary: { enabled: false, botToken: 'two' },
          },
        },
        discord: {
          enabled: false,
          token: 'legacy-top-level-token',
        },
        signal: {
          enabled: false,
        },
      },
    });

    expect(result.telegram).toEqual({
      defaultAccountId: 'secondary',
      accountIds: ['primary', 'secondary'],
    });
    expect(result.discord).toEqual({
      defaultAccountId: 'default',
      accountIds: ['default'],
    });
    expect(result.signal).toBeUndefined();
  });
});
