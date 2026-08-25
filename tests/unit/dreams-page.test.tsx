import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { Dreams } from '@/pages/Dreams';

const tMock = (key: string) => key;

const { kernelState, hostApiMock } = vi.hoisted(() => ({
  kernelState: {
    runtimes: {
      openclaw: { kernelId: 'openclaw', state: 'ready', generation: 1, diagnostics: [] },
    } as Record<string, Record<string, unknown>>,
  },
  hostApiMock: {
    openClawDreams: {
      status: vi.fn(),
      diary: vi.fn(),
      run: vi.fn(),
      setEnabled: vi.fn(),
      openFullUi: vi.fn(),
    },
    settings: {
      getAll: vi.fn(),
      get: vi.fn(),
      set: vi.fn(),
      setMany: vi.fn(),
      reset: vi.fn(),
    },
    logs: {
      recent: vi.fn(),
      dir: vi.fn(),
      listFiles: vi.fn(),
      readFile: vi.fn(),
    },
  },
}));

vi.mock('@/stores/kernels', () => ({
  useKernelStore: (selector: (state: typeof kernelState) => unknown) => selector(kernelState),
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: hostApiMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: tMock,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Dreams page OpenClaw runtime readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kernelState.runtimes = {
      openclaw: { kernelId: 'openclaw', state: 'ready', generation: 1, diagnostics: [] },
    };
    hostApiMock.openClawDreams.status.mockResolvedValue({
      dreaming: {
        enabled: true,
        shortTermCount: 1,
        groundedSignalCount: 0,
        totalSignalCount: 1,
        promotedToday: 0,
        shortTermEntries: [],
        promotedEntries: [],
      },
    });
    hostApiMock.openClawDreams.diary.mockResolvedValue({ found: true, content: '' });
  });

  it('does not call the allowlisted extension until the OpenClaw runtime is ready', async () => {
    kernelState.runtimes.openclaw = {
      kernelId: 'openclaw', state: 'starting', generation: 1, diagnostics: [],
    };
    const { rerender } = render(<Dreams />);

    expect(screen.getByTestId('dreams-refresh')).toBeDisabled();
    expect(screen.getByTestId('dreams-enable')).toBeDisabled();
    expect(screen.getByText('runtimeNotReady')).toBeVisible();
    await waitFor(() => {
      expect(hostApiMock.openClawDreams.status).not.toHaveBeenCalled();
      expect(hostApiMock.openClawDreams.diary).not.toHaveBeenCalled();
    });

    kernelState.runtimes.openclaw = {
      kernelId: 'openclaw', state: 'ready', generation: 1, diagnostics: [],
    };
    await act(async () => {
      rerender(<Dreams />);
    });

    await waitFor(() => {
      expect(hostApiMock.openClawDreams.status).toHaveBeenCalledTimes(1);
      expect(hostApiMock.openClawDreams.diary).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId('dreams-refresh')).toBeEnabled();
  });
});
