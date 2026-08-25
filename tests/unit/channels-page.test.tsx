import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Channels } from '@/pages/Channels/index';
import { CHANNEL_META, SUPPORTED_CHANNEL_TYPES } from '@shared/types/channel';

const hostApiCallMock = vi.fn();
const subscribeHostEventMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const toastWarningMock = vi.fn();

const { kernelState } = vi.hoisted(() => ({
  kernelState: {
    catalog: {
      entries: [
        { kernelId: 'openclaw', displayName: 'OpenClaw' },
        { kernelId: 'deepseek-harness', displayName: 'DeepSeek Harness' },
      ],
    },
    runtimes: {
      openclaw: { kernelId: 'openclaw', state: 'ready', generation: 1, diagnostics: [] },
      'deepseek-harness': { kernelId: 'deepseek-harness', state: 'ready', generation: 1, diagnostics: [] },
    } as Record<string, Record<string, unknown>>,
    restart: vi.fn(),
  },
}));

vi.mock('@/stores/kernels', () => ({
  kernelDisplayName: (kernelId: string) => kernelId === 'openclaw' ? 'OpenClaw' : kernelId === 'deepseek-harness' ? 'DeepSeek Harness' : kernelId,
  useKernelStore: (selector: (state: typeof kernelState) => unknown) => selector(kernelState),
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    agents: {
      list: () => hostApiCallMock('agents.list'),
    },
    channels: {
      accounts: (options?: { mode?: string; probe?: boolean }) => hostApiCallMock('channels.accounts', options),
      formValues: (channelType: string, accountId?: string) => {
        return hostApiCallMock('channels.formValues', { channelType, accountId });
      },
      saveConfig: (input: unknown) => hostApiCallMock('channels.saveConfig', input),
      deleteConfig: (channelType: string, accountId?: string) => {
        return hostApiCallMock('channels.deleteConfig', { channelType, accountId });
      },
      validateCredentials: (channelType: string, config: Record<string, unknown>) => (
        hostApiCallMock('channels.validateCredentials', { channelType, config })
      ),
      saveBinding: (input: unknown) => hostApiCallMock('channels.saveBinding', input),
      deleteBinding: (input: unknown) => hostApiCallMock('channels.deleteBinding', input),
      startLogin: (channelType: string, input?: unknown) => hostApiCallMock('channels.startLogin', { channelType, input }),
      cancelLogin: (channelType: string, input?: unknown) => hostApiCallMock('channels.cancelLogin', { channelType, input }),
    },
  },
}));

vi.mock('@/lib/host-events', () => ({
  hostEvents: {
    onChannelStatusChanged: (handler: unknown) => subscribeHostEventMock('channels:status-changed', handler),
    onKernelStatusChanged: (handler: unknown) => subscribeHostEventMock('kernels:status-changed', handler),
    onChannelQr: (channel: string, handler: unknown) => subscribeHostEventMock(`channel:${channel}-qr`, handler),
    onChannelSuccess: (channel: string, handler: unknown) => subscribeHostEventMock(`channel:${channel}-success`, handler),
    onChannelError: (channel: string, handler: unknown) => subscribeHostEventMock(`channel:${channel}-error`, handler),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    warning: (...args: unknown[]) => toastWarningMock(...args),
  },
}));

vi.mock('@/components/ui/secure-secret-input', async () => {
  const React = await import('react');
  type MockSecretInputProps = React.InputHTMLAttributes<HTMLInputElement> & {
    onPresenceChange?: (hasValue: boolean) => void;
  };
  type MockSecretInputHandle = {
    stage(): Promise<string | null>;
    clear(): void;
    focus(): void;
  };
  const SecureSecretInput = React.forwardRef<MockSecretInputHandle, MockSecretInputProps>(
    function MockSecureSecretInput({ onPresenceChange, ...props }, ref) {
      const [value, setValue] = React.useState('');
      const inputRef = React.useRef<HTMLInputElement>(null);
      React.useImperativeHandle(ref, () => ({
        stage: async () => value ? `credential-stage://test/${encodeURIComponent(value)}` : null,
        clear: () => {
          setValue('');
          onPresenceChange?.(false);
        },
        focus: () => inputRef.current?.focus(),
      }), [onPresenceChange, value]);
      return (
        <input
          {...props}
          ref={inputRef}
          type="password"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            onPresenceChange?.(event.target.value.length > 0);
          }}
        />
      );
    },
  );
  return { SecureSecretInput };
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Channels page status refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: {
        writeText: vi.fn(),
      },
      configurable: true,
    });
    kernelState.runtimes = {
      openclaw: { kernelId: 'openclaw', state: 'ready', generation: 1, diagnostics: [] },
      'deepseek-harness': { kernelId: 'deepseek-harness', state: 'ready', generation: 1, diagnostics: [] },
    };
    kernelState.catalog.entries = [
      { kernelId: 'openclaw', displayName: 'OpenClaw' },
      { kernelId: 'deepseek-harness', displayName: 'DeepSeek Harness' },
    ];
    kernelState.restart.mockReset().mockResolvedValue(true);
    hostApiCallMock.mockImplementation(async (path: string) => {
      if (path === 'channels.accounts') {
        return {
          success: true,
          gatewayHealth: {
            state: 'healthy',
            reasons: [],
            consecutiveHeartbeatMisses: 0,
          },
          channels: [
            {
              channelType: 'feishu',
              defaultAccountId: 'default',
              status: 'connected',
              accounts: [
                {
                  accountId: 'default',
                  name: 'Primary Account',
                  configured: true,
                  status: 'connected',
                  isDefault: true,
                },
              ],
            },
          ],
        };
      }

      if (path === 'agents.list') {
        return {
          success: true,
          agents: [],
        };
      }

      throw new Error(`Unexpected host API path: ${path}`);
    });
  });

  it('defines exactly the eight ClawX-supported channel integrations', () => {
    expect(Object.keys(CHANNEL_META).sort()).toEqual([...SUPPORTED_CHANNEL_TYPES].sort());
  });

  it('filters runtime channel groups that ClawX does not support', async () => {
    subscribeHostEventMock.mockImplementation(() => vi.fn());
    const unsupportedChannelTypes = [
      'signal',
      'imessage',
      'matrix',
      'line',
      'msteams',
      'googlechat',
      'mattermost',
    ];
    hostApiCallMock.mockImplementation(async (path: string) => {
      if (path === 'channels.accounts') {
        return {
          success: true,
          channels: [
            {
              channelType: 'feishu',
              defaultAccountId: 'default',
              status: 'connected',
              accounts: [],
            },
            ...unsupportedChannelTypes.map((channelType) => ({
              channelType,
              defaultAccountId: 'default',
              status: 'connected',
              accounts: [{
                accountId: 'default',
                name: `unsupported-${channelType}`,
                configured: true,
                status: 'connected',
                isDefault: true,
              }],
            })),
          ],
        };
      }
      if (path === 'agents.list') return { success: true, agents: [] };
      throw new Error(`Unexpected host API path: ${path}`);
    });

    render(<Channels />);

    await waitFor(() => {
      expect(screen.getByText('Feishu / Lark')).toBeInTheDocument();
      expect(screen.getByText('Telegram')).toBeInTheDocument();
    });
    for (const channelType of unsupportedChannelTypes) {
      expect(screen.queryByText(channelType, { exact: true })).not.toBeInTheDocument();
      expect(screen.queryByText(`unsupported-${channelType}`)).not.toBeInTheDocument();
    }
  });

  it('blocks saving when custom account ID is non-canonical', async () => {
    subscribeHostEventMock.mockImplementation(() => vi.fn());
    hostApiCallMock.mockImplementation(async (path: string) => {
      if (path === 'channels.accounts') {
        return {
          success: true,
          channels: [
            {
              channelType: 'feishu',
              defaultAccountId: 'default',
              status: 'connected',
              accounts: [
                {
                  accountId: 'default',
                  name: 'Primary Account',
                  configured: true,
                  status: 'connected',
                  isDefault: true,
                },
              ],
            },
          ],
        };
      }

      if (path === 'agents.list') {
        return {
          success: true,
          agents: [],
        };
      }

      if (path === 'channels.validateCredentials') {
        return {
          success: true,
          valid: true,
          warnings: [],
        };
      }

      if (path === 'channels.saveConfig') {
        return {
          success: true,
        };
      }

      throw new Error(`Unexpected host API path: ${path}`);
    });

    render(<Channels />);

    await waitFor(() => {
      expect(screen.getByText('Feishu / Lark')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'account.add' }));

    await waitFor(() => {
      expect(screen.getByText('dialog.configureTitle')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('account.customIdLabel'), {
      target: { value: '测试账号' },
    });
    const appIdInput = document.getElementById('appId') as HTMLInputElement | null;
    const appSecretInput = document.getElementById('appSecret') as HTMLInputElement | null;
    expect(appIdInput).not.toBeNull();
    expect(appSecretInput).not.toBeNull();
    fireEvent.change(appIdInput!, { target: { value: 'cli_test' } });
    fireEvent.change(appSecretInput!, { target: { value: 'secret_test' } });

    fireEvent.click(screen.getByRole('button', { name: 'dialog.saveAndConnect' }));

    await waitFor(() => {
      expect(screen.getByText('account.invalidCanonicalId')).toBeInTheDocument();
    });
    expect(toastErrorMock).toHaveBeenCalledWith('account.invalidCanonicalId');

    const saveCalls = hostApiCallMock.mock.calls.filter(([path]) => path === 'channels.saveConfig');
    expect(saveCalls).toHaveLength(0);
  });

  it('uses a config-only refresh immediately after a channel save', async () => {
    subscribeHostEventMock.mockImplementation(() => vi.fn());
    hostApiCallMock.mockImplementation(async (path: string) => {
      if (path === 'channels.accounts') {
        return { success: true, channels: [] };
      }
      if (path === 'agents.list') return { success: true, agents: [] };
      if (path === 'channels.validateCredentials') {
        return { success: true, valid: true, warnings: [] };
      }
      if (path === 'channels.saveConfig') {
        return { success: true, activationPending: true };
      }
      throw new Error(`Unexpected host API path: ${path}`);
    });

    render(<Channels />);
    await screen.findByRole('button', { name: /QQ Bot/ });
    hostApiCallMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /QQ Bot/ }));
    fireEvent.change(document.getElementById('appId') as HTMLInputElement, {
      target: { value: 'qq-app-id' },
    });
    fireEvent.change(document.getElementById('clientSecret') as HTMLInputElement, {
      target: { value: 'qq-client-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'dialog.saveAndConnect' }));

    await waitFor(() => {
      expect(screen.queryByText('dialog.configureTitle')).not.toBeInTheDocument();
    });
    const postSaveAccountCalls = hostApiCallMock.mock.calls.filter(
      ([path]) => path === 'channels.accounts',
    );
    expect(postSaveAccountCalls).toEqual([
      ['channels.accounts', expect.objectContaining({ mode: 'config', probe: false })],
    ]);
  });

  it('removes a channel optimistically before the host delete settles', async () => {
    subscribeHostEventMock.mockImplementation(() => vi.fn());
    const deleteDeferred = createDeferred<{ success: true }>();
    hostApiCallMock.mockImplementation(async (path: string) => {
      if (path === 'channels.accounts') {
        return {
          success: true,
          channels: [{
            channelType: 'feishu',
            defaultAccountId: 'default',
            status: 'connected',
            accounts: [{
              accountId: 'default',
              name: 'Primary Account',
              configured: true,
              status: 'connected',
              isDefault: true,
            }],
          }],
        };
      }
      if (path === 'agents.list') return { success: true, agents: [] };
      if (path === 'channels.deleteConfig') return deleteDeferred.promise;
      throw new Error(`Unexpected host API path: ${path}`);
    });

    render(<Channels />);
    await screen.findByTitle('account.deleteChannel');
    fireEvent.click(screen.getByTitle('account.deleteChannel'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm-button'));

    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog-confirm-button')).not.toBeInTheDocument();
      expect(screen.queryByTitle('account.deleteChannel')).not.toBeInTheDocument();
    });
    expect(toastSuccessMock).not.toHaveBeenCalled();

    await act(async () => {
      deleteDeferred.resolve({ success: true });
      await deleteDeferred.promise;
    });
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith('toast.channelDeleted');
    });
  });

  it('restores the config-backed view when an optimistic channel delete fails', async () => {
    subscribeHostEventMock.mockImplementation(() => vi.fn());
    const deleteDeferred = createDeferred<{ success: true }>();
    hostApiCallMock.mockImplementation(async (path: string) => {
      if (path === 'channels.accounts') {
        return {
          success: true,
          channels: [{
            channelType: 'feishu',
            defaultAccountId: 'default',
            status: 'connected',
            accounts: [{
              accountId: 'default',
              name: 'Primary Account',
              configured: true,
              status: 'connected',
              isDefault: true,
            }],
          }],
        };
      }
      if (path === 'agents.list') return { success: true, agents: [] };
      if (path === 'channels.deleteConfig') return deleteDeferred.promise;
      throw new Error(`Unexpected host API path: ${path}`);
    });

    render(<Channels />);
    await screen.findByTitle('account.deleteChannel');
    fireEvent.click(screen.getByTitle('account.deleteChannel'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm-button'));

    await waitFor(() => {
      expect(screen.queryByTitle('account.deleteChannel')).not.toBeInTheDocument();
    });
    await act(async () => {
      deleteDeferred.reject(new Error('delete failed'));
      try {
        await deleteDeferred.promise;
      } catch {
        // Expected host failure.
      }
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('toast.configFailed');
      expect(hostApiCallMock).toHaveBeenCalledWith(
        'channels.accounts',
        expect.objectContaining({ mode: 'config', probe: false }),
      );
      expect(screen.getByTitle('account.deleteChannel')).toBeInTheDocument();
    });
  });

  it('refetches channel accounts when canonical channel status events arrive', async () => {
    let channelStatusHandler: (() => void) | undefined;
    subscribeHostEventMock.mockImplementation((eventName: string, handler: () => void) => {
      if (eventName === 'channels:status-changed') {
        channelStatusHandler = handler;
      }
      return vi.fn();
    });

    render(<Channels />);

    await waitFor(() => {
      expect(hostApiCallMock).toHaveBeenCalledWith('channels.accounts', expect.objectContaining({ mode: 'runtime' }));
      expect(hostApiCallMock).toHaveBeenCalledWith('agents.list');
    });
    expect(subscribeHostEventMock).toHaveBeenCalledWith('channels:status-changed', expect.any(Function));

    await act(async () => {
      channelStatusHandler?.();
    });

    await waitFor(() => {
      const channelFetchCalls = hostApiCallMock.mock.calls.filter(([path, options]) => (
        path === 'channels.accounts' && (options as { mode?: string } | undefined)?.mode !== 'config'
      ));
      const agentFetchCalls = hostApiCallMock.mock.calls.filter(([path]) => path === 'agents.list');
      expect(channelFetchCalls).toHaveLength(2);
      expect(agentFetchCalls).toHaveLength(1);
    });
  });

  it('refetches when a kernel lifecycle event arrives after mount', async () => {
    let kernelStatusHandler: (() => void) | undefined;
    subscribeHostEventMock.mockImplementation((eventName: string, handler: () => void) => {
      if (eventName === 'kernels:status-changed') kernelStatusHandler = handler;
      return vi.fn();
    });

    render(<Channels />);

    await waitFor(() => {
      expect(hostApiCallMock).toHaveBeenCalledWith('channels.accounts', expect.objectContaining({ mode: 'runtime' }));
      expect(hostApiCallMock).toHaveBeenCalledWith('agents.list');
    });

    await act(async () => {
      kernelStatusHandler?.();
    });

    await waitFor(() => {
      const channelFetchCalls = hostApiCallMock.mock.calls.filter(([path, options]) => (
        path === 'channels.accounts' && (options as { mode?: string } | undefined)?.mode !== 'config'
      ));
      const agentFetchCalls = hostApiCallMock.mock.calls.filter(([path]) => path === 'agents.list');
      expect(channelFetchCalls).toHaveLength(2);
      expect(agentFetchCalls).toHaveLength(1);
    });
  });

  it('renders channel data without waiting for slow agents request', async () => {
    subscribeHostEventMock.mockImplementation(() => vi.fn());

    const agentsDeferred = createDeferred<{
      success: boolean;
      agents: Array<Record<string, unknown>>;
    }>();

    hostApiCallMock.mockImplementation((path: string) => {
      if (path === 'channels.accounts') {
        return Promise.resolve({
          success: true,
          channels: [
            {
              channelType: 'feishu',
              defaultAccountId: 'default',
              status: 'connected',
              accounts: [
                {
                  accountId: 'default',
                  name: 'Primary Account',
                  configured: true,
                  status: 'connected',
                  isDefault: true,
                },
              ],
            },
          ],
        });
      }
      if (path === 'agents.list') {
        return agentsDeferred.promise;
      }
      throw new Error(`Unexpected host API path: ${path}`);
    });

    render(<Channels />);

    expect(await screen.findByText('Feishu / Lark')).toBeInTheDocument();

    await act(async () => {
      agentsDeferred.resolve({ success: true, agents: [] });
    });
  });

  it('treats WeChat accounts as plugin-managed QR accounts', async () => {
    subscribeHostEventMock.mockImplementation(() => vi.fn());
    hostApiCallMock.mockImplementation(async (path: string) => {
      if (path === 'channels.accounts') {
        return {
          success: true,
          channels: [
            {
              channelType: 'wechat',
              defaultAccountId: 'wx-bot-im-bot',
              status: 'connected',
              accounts: [
                {
                  accountId: 'wx-bot-im-bot',
                  name: 'WeChat ClawBot',
                  configured: true,
                  status: 'connected',
                  isDefault: true,
                },
              ],
            },
          ],
        };
      }

      if (path === 'agents.list') {
        return {
          success: true,
          agents: [],
        };
      }

      if (path === 'channels.cancelLogin') {
        return { success: true };
      }

      throw new Error(`Unexpected host API path: ${path}`);
    });

    render(<Channels />);

    await waitFor(() => {
      expect(screen.getByText('WeChat')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'account.add' }));

    await waitFor(() => {
      expect(screen.getByText('dialog.configureTitle')).toBeInTheDocument();
    });

    expect(screen.queryByLabelText('account.customIdLabel')).not.toBeInTheDocument();
  });

  it('keeps the last channel snapshot visible while refresh is pending', async () => {
    subscribeHostEventMock.mockImplementation(() => vi.fn());

    const channelsDeferred = createDeferred<{
      success: boolean;
      channels: Array<Record<string, unknown>>;
    }>();
    const agentsDeferred = createDeferred<{
      success: boolean;
      agents: Array<Record<string, unknown>>;
    }>();

    let refreshCallCount = 0;
    hostApiCallMock.mockImplementation((path: string) => {
      if (path === 'channels.accounts') {
        if (refreshCallCount === 0) {
          refreshCallCount += 1;
          return Promise.resolve({
            success: true,
            channels: [
              {
                channelType: 'feishu',
                defaultAccountId: 'default',
                status: 'connected',
                accounts: [
                  {
                    accountId: 'default',
                    name: 'Primary Account',
                    configured: true,
                    status: 'connected',
                    isDefault: true,
                  },
                ],
              },
            ],
          });
        }
        return channelsDeferred.promise;
      }

      if (path === 'agents.list') {
        if (refreshCallCount === 1) {
          return Promise.resolve({ success: true, agents: [] });
        }
        return agentsDeferred.promise;
      }

      throw new Error(`Unexpected host API path: ${path}`);
    });

    render(<Channels />);

    expect(await screen.findByText('Feishu / Lark')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));

    expect(screen.getByText('Feishu / Lark')).toBeInTheDocument();

    await act(async () => {
      channelsDeferred.resolve({
        success: true,
        channels: [
          {
            channelType: 'feishu',
            defaultAccountId: 'default',
            status: 'connected',
            accounts: [
              {
                accountId: 'default',
                name: 'Primary Account',
                configured: true,
                status: 'connected',
                isDefault: true,
              },
            ],
          },
        ],
      });
      agentsDeferred.resolve({ success: true, agents: [] });
    });
  });

  it('keeps filled Feishu credentials when account ID is edited', async () => {
    subscribeHostEventMock.mockImplementation(() => vi.fn());

    render(<Channels />);

    await waitFor(() => {
      expect(screen.getByText('Feishu / Lark')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'account.add' }));

    const appIdInput = await screen.findByPlaceholderText('channels:meta.feishu.fields.appId.placeholder');
    const appSecretInput = screen.getByPlaceholderText('channels:meta.feishu.fields.appSecret.placeholder');
    const accountIdInput = screen.getByLabelText('account.customIdLabel');

    fireEvent.change(appIdInput, { target: { value: 'cli_test_app' } });
    fireEvent.change(appSecretInput, { target: { value: 'secret_test_value' } });
    fireEvent.change(accountIdInput, { target: { value: 'feishu-renamed-account' } });

    expect(appIdInput).toHaveValue('cli_test_app');
    expect(appSecretInput).toHaveValue('secret_test_value');
  });

  it('shows a kernel-scoped health banner and restarts only the affected runtime', async () => {
    subscribeHostEventMock.mockImplementation(() => vi.fn());
    kernelState.runtimes.openclaw = {
      kernelId: 'openclaw', state: 'degraded', generation: 3, diagnostics: ['health timeout'],
    };
    hostApiCallMock.mockImplementation(async (path: string) => {
      if (path === 'channels.accounts') {
        return {
          success: true,
          channels: [{
            channelType: 'feishu',
            defaultAccountId: 'default',
            status: 'degraded',
            accounts: [{
              accountId: 'default',
              name: 'Primary Account',
              configured: true,
              status: 'degraded',
              isDefault: true,
              kernelId: 'openclaw',
            }],
          }],
        };
      }
      if (path === 'agents.list') return { success: true, agents: [] };
      throw new Error(`Unexpected host API path: ${path}`);
    });

    render(<Channels />);

    expect(await screen.findByTestId('channels-kernel-health-banner')).toBeInTheDocument();
    expect(screen.getByTestId('channels-kernel-health-openclaw')).toHaveTextContent(
      'OpenClaw · common:kernels.states.degraded',
    );
    expect(screen.queryByTestId('channels-kernel-health-deepseek-harness')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('channels-restart-kernel-openclaw'));
    await waitFor(() => expect(kernelState.restart).toHaveBeenCalledWith('openclaw'));
  });

  it('supports a future catalog kernel without adding a page-level backend branch', async () => {
    subscribeHostEventMock.mockImplementation(() => vi.fn());
    kernelState.catalog.entries.push({ kernelId: 'future-kernel', displayName: 'Future Kernel' });
    kernelState.runtimes['future-kernel'] = {
      kernelId: 'future-kernel', state: 'failed', generation: 9, diagnostics: ['failed'],
    };
    hostApiCallMock.mockImplementation(async (path: string) => {
      if (path === 'channels.accounts') {
        return {
          success: true,
          channels: [{
            channelType: 'telegram',
            defaultAccountId: 'future',
            status: 'degraded',
            accounts: [{
              accountId: 'future',
              name: 'Future Account',
              configured: true,
              status: 'degraded',
              isDefault: true,
              kernelId: 'future-kernel',
            }],
          }],
        };
      }
      if (path === 'agents.list') return { success: true, agents: [] };
      throw new Error(`Unexpected host API path: ${path}`);
    });

    render(<Channels />);

    expect(await screen.findByTestId('channels-kernel-health-future-kernel')).toHaveTextContent(
      'future-kernel · common:kernels.states.failed',
    );
    fireEvent.click(screen.getByTestId('channels-restart-kernel-future-kernel'));
    await waitFor(() => expect(kernelState.restart).toHaveBeenCalledWith('future-kernel'));
  });

  it('does not derive page health from a legacy global gateway payload', async () => {
    subscribeHostEventMock.mockImplementation(() => vi.fn());
    hostApiCallMock.mockImplementation(async (path: string) => {
      if (path === 'channels.accounts') {
        return {
          success: true,
          gatewayHealth: { state: 'degraded', reasons: ['legacy'], consecutiveHeartbeatMisses: 99 },
          channels: [{
            channelType: 'feishu',
            defaultAccountId: 'default',
            status: 'connected',
            accounts: [{
              accountId: 'default',
              name: 'Primary Account',
              configured: true,
              status: 'connected',
              isDefault: true,
              kernelId: 'openclaw',
            }],
          }],
        };
      }
      if (path === 'agents.list') return { success: true, agents: [] };
      throw new Error(`Unexpected host API path: ${path}`);
    });

    render(<Channels />);

    expect(await screen.findByText('Feishu / Lark')).toBeInTheDocument();
    expect(screen.queryByTestId('channels-kernel-health-banner')).not.toBeInTheDocument();
  });

});
