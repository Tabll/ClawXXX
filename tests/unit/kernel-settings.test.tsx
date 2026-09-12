import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KernelSettings } from '@/components/settings/KernelSettings';
import { useKernelStore } from '@/stores/kernels';
import type { KernelRuntimeSnapshot } from '@shared/kernels/contracts';
import en from '../../shared/i18n/locales/en/settings.json';
import zh from '../../shared/i18n/locales/zh/settings.json';
import ja from '../../shared/i18n/locales/ja/settings.json';
import ru from '../../shared/i18n/locales/ru/settings.json';
import commonEn from '../../shared/i18n/locales/en/common.json';
import commonZh from '../../shared/i18n/locales/zh/common.json';
import commonJa from '../../shared/i18n/locales/ja/common.json';
import commonRu from '../../shared/i18n/locales/ru/common.json';

vi.mock('@/lib/host-api', () => ({ hostApi: {} }));
vi.mock('@/lib/host-events', () => ({ hostEvents: {} }));

const translations = { en, zh, ja, ru };
const common = { en: commonEn, zh: commonZh, ja: commonJa, ru: commonRu };
const start = vi.fn(async () => true);
const update = vi.fn(async () => true);
const runtime: KernelRuntimeSnapshot = {
  kernelId: 'deepseek-harness', state: 'installed', generation: 0, restartRequired: false, diagnostics: [],
};

function setRuntime(patch: Partial<KernelRuntimeSnapshot>, pendingActivation = false) {
  const snapshot = { ...runtime, ...patch };
  useKernelStore.setState({
    catalog: {
      source: 'cache', stale: false, refreshedAt: '2026-09-11T00:00:00Z',
      entries: [{
        kernelId: 'deepseek-harness', displayName: 'DeepSeek Harness', runtime: snapshot,
        installation: {
          kernelId: 'deepseek-harness', state: 'installed', activeVersion: '1.0.0',
          ...(pendingActivation ? { desiredVersion: '2.0.0' } : {}), updatedAt: '2026-09-11T00:00:00Z',
        },
        availableVersion: '1.0.0', updateAvailable: false, installAllowed: true, compatibilityFailures: [],
      }],
    },
    runtimes: { 'deepseek-harness': snapshot },
  });
}

async function mount(locale: keyof typeof translations = 'zh') {
  const i18n = createInstance();
  await i18n.init({ lng: locale, defaultNS: 'settings', resources: { [locale]: { settings: translations[locale], common: common[locale] } } });
  return render(<I18nextProvider i18n={i18n}><KernelSettings /></I18nextProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  useKernelStore.setState({
    init: async () => {}, start, update, progress: {}, pending: {}, errors: {}, restartRequired: {},
  });
  setRuntime({});
});
afterEach(cleanup);

describe('kernel settings activation status (component tests, not Electron E2E)', () => {
  it('enables a hot-registered installed kernel immediately', async () => {
    await mount();
    const button = screen.getByTestId('settings-kernel-start-deepseek-harness');
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(start).toHaveBeenCalledWith('deepseek-harness');
    expect(screen.queryByText(zh.kernels.appRestartRequired)).not.toBeInTheDocument();
  });

  it.each(['en', 'zh', 'ja', 'ru'] as const)('explains app restart and blocks kernel restart/start in %s', async locale => {
    setRuntime({ restartRequired: true });
    await mount(locale);
    expect(screen.getByText(translations[locale].kernels.appRestartRequired)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(translations[locale].kernels.appRestartRequiredDescription);
    expect(screen.getByTestId('settings-kernel-start-deepseek-harness')).toBeDisabled();
    expect(screen.getByTestId('settings-kernel-restart-deepseek-harness')).toBeDisabled();
  });

  it('keeps failed launch and installed package facts visible without offering reinstall', async () => {
    setRuntime({ state: 'failed', lastError: 'Launch registration failed' });
    await mount();
    expect(screen.getByRole('alert')).toHaveTextContent('Launch registration failed');
    expect(screen.getByText(commonZh.kernels.states.failed)).toBeInTheDocument();
    expect(screen.queryByText(commonZh.kernels.states['not-installed'])).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-kernel-install-deepseek-harness')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-kernel-start-deepseek-harness')).toBeEnabled();
  });

  it('explains inactive downloads separately and provides Update for activation', async () => {
    setRuntime({}, true);
    await mount();
    expect(screen.getByText(zh.kernels.activationPending)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('2.0.0');
    expect(screen.queryByText(zh.kernels.appRestartRequired)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('settings-kernel-update-deepseek-harness'));
    expect(update).toHaveBeenCalledWith('deepseek-harness');
  });
});
