/**
 * Main Layout Component
 * Platform-aware application shell.
 */
import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';
import { MAC_SIDEBAR_CHROME_HEIGHT } from '@shared/sidebar-layout';
import { hostApi } from '@/lib/host-api';
import { cn } from '@/lib/utils';

export function MainLayout() {
  const location = useLocation();
  const platform = window.electron?.platform;
  const isMac = platform === 'darwin';
  const isWin = platform === 'win32';
  const isSettingsRoute = location.pathname.startsWith('/settings');

  useEffect(() => {
    if (!isMac || !isSettingsRoute) return;
    void hostApi.window.syncTrafficLightPosition(false);
  }, [isMac, isSettingsRoute]);

  return (
    <div
      data-testid="main-layout"
      data-platform={platform}
      className={cn(
        'flex h-screen overflow-hidden',
        isWin ? 'bg-surface-sidebar' : 'bg-background',
        isMac ? 'flex-row' : 'flex-col',
      )}
    >
      <TitleBar />

      <div className={cn(
        'flex min-h-0 flex-1 overflow-hidden',
        isSettingsRoute ? 'bg-background' : 'bg-surface-sidebar',
      )}>
        {!isSettingsRoute && <Sidebar />}
        <main
          data-testid="main-content"
          className={cn(
            'relative min-h-0 flex-1 overflow-auto bg-background',
            isSettingsRoute
              ? 'p-0'
              : 'rounded-tl-2xl border-l border-border/60 p-6',
            !isSettingsRoute && !isWin && 'border-t border-border/60',
          )}
        >
          {isMac && (
            <div
              data-testid="mac-main-drag-region"
              aria-hidden="true"
              className="drag-region absolute inset-x-0 top-0 z-10"
              style={{ height: MAC_SIDEBAR_CHROME_HEIGHT }}
            />
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
