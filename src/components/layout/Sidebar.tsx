/**
 * Sidebar Component
 * Navigation sidebar with menu items.
 * No longer fixed - sits inside the flex layout below the title bar.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  MessagesSquare,
  UsersRound,
  Blocks,
  Clock,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeft,
  MessageCirclePlus,
  Terminal,
  ExternalLink,
  Trash2,
  Pencil,
  Pin,
  PinOff,
  Check,
  X,
  Moon,
  ChevronRight,
  Loader2,
  Search,
  MoreHorizontal,
  ListChecks,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { isGatewayRestarting } from '@/lib/gateway-status';
import { rendererExtensionRegistry } from '@/extensions/registry';
import { useSettingsStore } from '@/stores/settings';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { getSessionActivityMs, getSessionBucket, type SessionBucketKey } from './session-buckets';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { hostApi } from '@/lib/host-api';
import { SIDEBAR_COLLAPSED_WIDTH, MAC_SIDEBAR_CHROME_HEIGHT } from '@shared/sidebar-layout';
import { useTranslation } from 'react-i18next';
import logoSvg from '@/assets/logo.svg';
import { useNewChatAction } from './use-new-chat-action';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  collapsed?: boolean;
  onClick?: () => void;
  testId?: string;
}

const sidebarNavItemClasses = (active?: boolean, collapsed?: boolean) =>
  cn(
    'clawx-nav-item',
    active && 'clawx-nav-item-active font-medium',
    collapsed && 'justify-center px-0',
  );

function NavItem({ to, icon, label, badge, collapsed, onClick, testId }: NavItemProps) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      data-testid={testId}
      className={({ isActive }) =>
        sidebarNavItemClasses(isActive, collapsed)
      }
    >
      <>
        <div className="flex shrink-0 items-center justify-center text-current [&_svg]:size-4">
          {icon}
        </div>
        {!collapsed && (
          <>
            <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
            {badge && (
              <Badge variant="secondary" className="ml-auto shrink-0">
                {badge}
              </Badge>
            )}
          </>
        )}
      </>
    </NavLink>
  );
}

const INITIAL_NOW_MS = Date.now();
type SidebarSessionBucketKey = 'pinned' | SessionBucketKey;

const DEFAULT_EXPANDED_SESSION_BUCKETS: Record<SidebarSessionBucketKey, boolean> = {
  pinned: true,
  today: true,
  withinWeek: true,
  withinMonth: false,
  older: false,
};

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  const [, agentId] = sessionKey.split(':');
  return agentId || 'main';
}

export function Sidebar() {
  const isMac = window.electron?.platform === 'darwin';
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore((state) => state.setSidebarCollapsed);
  const sidebarWidth = useSettingsStore((state) => state.sidebarWidth);
  const setSidebarWidth = useSettingsStore((state) => state.setSidebarWidth);
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const [isResizing, setIsResizing] = useState(false);
  const stopResizeRef = useRef<(() => void) | null>(null);

  const sessions = useChatStore((s) => s.sessions);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessionLabels = useChatStore((s) => s.sessionLabels);
  const sessionLastActivity = useChatStore((s) => s.sessionLastActivity);
  const switchSession = useChatStore((s) => s.switchSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const renameSession = useChatStore((s) => s.renameSession);
  const setSessionPinned = useChatStore((s) => s.setSessionPinned);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const loadHistory = useChatStore((s) => s.loadHistory);
  const handleNewChat = useNewChatAction();

  const gatewayStatus = useGatewayStore((s) => s.status);
  const isGatewayRunning = gatewayStatus.state === 'running';
  const isGatewayReady = isGatewayRunning && gatewayStatus.gatewayReady !== false;
  const gatewayRestarting = isGatewayRestarting(gatewayStatus);
  const gatewayRuntimeKey = `${gatewayStatus.pid ?? 'none'}:${gatewayStatus.connectedAt ?? 'none'}:${gatewayStatus.port}`;

  const hasLoadedCurrentRuntimeRef = useRef(false);

  useEffect(() => {
    hasLoadedCurrentRuntimeRef.current = false;
  }, [gatewayRuntimeKey]);

  useEffect(() => {
    if (!isGatewayReady) return;
    let cancelled = false;
    (async () => {
      await loadSessions();
      if (cancelled) return;
      if (hasLoadedCurrentRuntimeRef.current) return;
      hasLoadedCurrentRuntimeRef.current = true;
      await loadHistory(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [gatewayRuntimeKey, isGatewayReady, loadHistory, loadSessions]);
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  useEffect(() => {
    if (!isMac) return;
    void hostApi.window.syncTrafficLightPosition(sidebarCollapsed);
  }, [isMac, sidebarCollapsed]);

  const navigate = useNavigate();
  const isOnChat = useLocation().pathname === '/';

  const getSessionLabel = (key: string, displayName?: string, label?: string) =>
    sessionLabels[key] ?? label ?? displayName ?? key;

  const openControlUi = async (view?: 'dreams', label = 'OpenClaw Page') => {
    try {
      const result = await hostApi.gateway.controlUi(view);
      if (result.success && result.url) {
        await window.electron.openExternal(result.url);
      } else {
        console.error(`Failed to get ${label} URL:`, result.error);
      }
    } catch (err) {
      console.error(`Error opening ${label}:`, err);
    }
  };

  const openDevConsole = async () => {
    await openControlUi(undefined, 'OpenClaw Page');
  };

  const { t } = useTranslation(['common', 'chat']);
  const [sessionToDelete, setSessionToDelete] = useState<{ key: string; label: string } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingSessionKey, setEditingSessionKey] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [sessionContextMenu, setSessionContextMenu] = useState<{
    key: string;
    label: string;
    pinned: boolean;
    x: number;
    y: number;
  } | null>(null);
  const sessionContextMenuRef = useRef<HTMLDivElement | null>(null);
  const [sidebarMoreMenuOpen, setSidebarMoreMenuOpen] = useState(false);
  const sidebarMoreMenuRef = useRef<HTMLDivElement | null>(null);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const [nowMs, setNowMs] = useState(INITIAL_NOW_MS);
  const [expandedSessionBuckets, setExpandedSessionBuckets] = useState<Record<SidebarSessionBucketKey, boolean>>(
    () => ({ ...DEFAULT_EXPANDED_SESSION_BUCKETS }),
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  useEffect(() => {
    if (deleteDialogOpen || !sessionToDelete) return;
    const timer = window.setTimeout(() => setSessionToDelete(null), 160);
    return () => window.clearTimeout(timer);
  }, [deleteDialogOpen, sessionToDelete]);

  const closeSessionContextMenu = useCallback(() => {
    setSessionContextMenu(null);
  }, []);

  const closeSidebarMoreMenu = useCallback(() => {
    setSidebarMoreMenuOpen(false);
  }, []);

  useEffect(() => {
    if (!sessionContextMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && sessionContextMenuRef.current?.contains(event.target)
      ) {
        return;
      }
      closeSessionContextMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSessionContextMenu();
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', closeSessionContextMenu);
    window.addEventListener('scroll', closeSessionContextMenu, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', closeSessionContextMenu);
      window.removeEventListener('scroll', closeSessionContextMenu, true);
    };
  }, [closeSessionContextMenu, sessionContextMenu]);

  useEffect(() => {
    if (!sidebarMoreMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && sidebarMoreMenuRef.current?.contains(event.target)
      ) {
        return;
      }
      closeSidebarMoreMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSidebarMoreMenu();
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', closeSidebarMoreMenu);
    window.addEventListener('scroll', closeSidebarMoreMenu, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', closeSidebarMoreMenu);
      window.removeEventListener('scroll', closeSidebarMoreMenu, true);
    };
  }, [closeSidebarMoreMenu, sidebarMoreMenuOpen]);

  const handleStartRename = (key: string, currentLabel: string) => {
    closeSessionContextMenu();
    setEditingSessionKey(key);
    setEditingLabel(currentLabel);
  };

  const handleRenameSubmit = async () => {
    if (!editingSessionKey || !editingLabel.trim()) {
      setEditingSessionKey(null);
      return;
    }
    try {
      await renameSession(editingSessionKey, editingLabel.trim());
    } catch (err) {
      console.error('Failed to rename session:', err);
    }
    setEditingSessionKey(null);
  };

  const handleRenameCancel = () => {
    setEditingSessionKey(null);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleRenameSubmit();
    } else if (e.key === 'Escape') {
      handleRenameCancel();
    }
  };

  const handleSessionContextMenu = (
    event: React.MouseEvent,
    key: string,
    label: string,
    pinned: boolean,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setSessionContextMenu({
      key,
      label,
      pinned,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const openSession = useCallback((sessionKey: string) => {
    if (currentSessionKey === sessionKey) {
      void loadHistory(false);
    } else {
      switchSession(sessionKey);
    }
    navigate('/');
  }, [currentSessionKey, loadHistory, navigate, switchSession]);

  const handleSessionSearchOpenChange = useCallback((open: boolean) => {
    setSessionSearchOpen(open);
    if (!open) setSessionSearchQuery('');
  }, []);

  const handleContextMenuPinToggle = async () => {
    const target = sessionContextMenu;
    if (!target) return;
    closeSessionContextMenu();
    try {
      await setSessionPinned(target.key, !target.pinned);
    } catch (err) {
      console.error('Failed to update session pin state:', err);
    }
  };

  const toggleSessionBucket = (bucketKey: SidebarSessionBucketKey) => {
    setExpandedSessionBuckets((current) => ({
      ...current,
      [bucketKey]: !current[bucketKey],
    }));
  };

  const stopResizing = useCallback(() => {
    stopResizeRef.current?.();
    stopResizeRef.current = null;
    setIsResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (sidebarCollapsed) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Window listeners below keep dragging reliable even if capture is unavailable.
      }

      const onMove = (moveEvent: PointerEvent) => {
        setSidebarWidth(moveEvent.clientX);
      };
      const onUp = () => stopResizing();

      stopResizeRef.current = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      setIsResizing(true);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [setSidebarWidth, sidebarCollapsed, stopResizing],
  );

  useEffect(() => stopResizing, [stopResizing]);

  const agentNameById = useMemo(
    () => Object.fromEntries((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const dateSessionBuckets: Array<{ key: SessionBucketKey; label: string; sessions: typeof sessions }> = [
    { key: 'today', label: t('chat:historyBuckets.today'), sessions: [] },
    { key: 'withinWeek', label: t('chat:historyBuckets.withinWeek'), sessions: [] },
    { key: 'withinMonth', label: t('chat:historyBuckets.withinMonth'), sessions: [] },
    { key: 'older', label: t('chat:historyBuckets.older'), sessions: [] },
  ];
  const sessionBucketMap = Object.fromEntries(dateSessionBuckets.map((bucket) => [bucket.key, bucket])) as Record<
    SessionBucketKey,
    (typeof dateSessionBuckets)[number]
  >;
  const pinnedSessions: typeof sessions = [];

  for (const { session, activityMs } of sessions
    .map((session) => ({
      session,
      activityMs: getSessionActivityMs(session, sessionLastActivity),
    }))
    .sort((a, b) => b.activityMs - a.activityMs)) {
    if (session.pinned) {
      pinnedSessions.push(session);
      continue;
    }
    const bucketKey = getSessionBucket(activityMs, nowMs);
    sessionBucketMap[bucketKey].sessions.push(session);
  }
  const sessionBuckets: Array<{ key: SidebarSessionBucketKey; label: string; sessions: typeof sessions }> = [
    ...(pinnedSessions.length > 0
      ? [{ key: 'pinned' as const, label: t('chat:historyBuckets.pinned'), sessions: pinnedSessions }]
      : []),
    ...dateSessionBuckets,
  ];

  const searchableSessions = useMemo(() => sessions.map((session) => {
    const agentId = getAgentIdFromSessionKey(session.key);
    const agentName = agentNameById[agentId] || agentId;
    const label = sessionLabels[session.key] ?? session.label ?? session.displayName ?? session.key;
    const activityMs = getSessionActivityMs(session, sessionLastActivity);
    return {
      key: session.key,
      label,
      agentName,
      pinned: Boolean(session.pinned),
      activityMs,
      searchText: [
        label,
        session.label,
        session.displayName,
        session.key,
        agentName,
      ].filter(Boolean).join(' ').toLowerCase(),
    };
  }).sort((a, b) => {
    const pinnedDelta = Number(b.pinned) - Number(a.pinned);
    return pinnedDelta || b.activityMs - a.activityMs;
  }), [agentNameById, sessionLabels, sessionLastActivity, sessions]);

  const normalizedSessionSearchQuery = sessionSearchQuery.trim().toLowerCase();
  const sessionSearchResults = useMemo(() => {
    const results = normalizedSessionSearchQuery
      ? searchableSessions.filter((session) => session.searchText.includes(normalizedSessionSearchQuery))
      : searchableSessions;
    return results.slice(0, normalizedSessionSearchQuery ? 30 : 12);
  }, [normalizedSessionSearchQuery, searchableSessions]);

  const openSearchResult = useCallback((sessionKey: string) => {
    openSession(sessionKey);
    handleSessionSearchOpenChange(false);
  }, [handleSessionSearchOpenChange, openSession]);

  const handleSessionSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    const firstResult = sessionSearchResults[0];
    if (!firstResult) return;
    event.preventDefault();
    openSearchResult(firstResult.key);
  };

  const hiddenRoutes = rendererExtensionRegistry.getHiddenRoutes();
  const extraNavItems = rendererExtensionRegistry.getExtraNavItems();

  const coreNavItems = [
    { to: '/agents', icon: <UsersRound className="h-4 w-4" strokeWidth={2} />, label: t('sidebar.agents'), testId: 'sidebar-nav-agents' },
    { to: '/channels', icon: <MessagesSquare className="h-4 w-4" strokeWidth={2} />, label: t('sidebar.channels'), testId: 'sidebar-nav-channels' },
    { to: '/skills', icon: <Blocks className="h-4 w-4" strokeWidth={2} />, label: t('sidebar.skills'), testId: 'sidebar-nav-skills' },
    { to: '/cron', icon: <Clock className="h-4 w-4" strokeWidth={2} />, label: t('sidebar.cronTasks'), testId: 'sidebar-nav-cron' },
    ...(devModeUnlocked
      ? [
        { to: '/dreams', icon: <Moon className="h-4 w-4" strokeWidth={2} />, label: t('common:sidebar.openClawDreams'), testId: 'sidebar-nav-dreams' },
      ]
      : []),
  ];

  const navItems = [
    ...coreNavItems.filter((item) => !hiddenRoutes.has(item.to)),
    ...extraNavItems.map((item) => ({
      to: item.to,
      icon: <item.icon className="h-4 w-4" strokeWidth={2} />,
      label: item.labelI18nKey ? t(item.labelI18nKey) : item.label,
      testId: item.testId,
    })),
  ];

  const contextMenuLeft = sessionContextMenu
    ? Math.min(sessionContextMenu.x, Math.max(8, window.innerWidth - 188))
    : 0;
  const contextMenuTop = sessionContextMenu
    ? Math.min(sessionContextMenu.y, Math.max(8, window.innerHeight - 92))
    : 0;

  return (
    <aside
      data-testid="sidebar"
      className={cn(
        'relative flex min-h-0 shrink-0 flex-col overflow-hidden bg-surface-sidebar',
        isResizing ? 'transition-none' : 'transition-[width] duration-300',
      )}
      style={{ width: sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth }}
    >
      {isMac && (
        <div
          aria-hidden="true"
          data-testid="mac-sidebar-chrome"
          className="drag-region shrink-0"
          style={{ height: MAC_SIDEBAR_CHROME_HEIGHT }}
        />
      )}

      {/* Top Header Toggle */}
      <div
        className={cn(
          'flex shrink-0 items-center p-2 h-8',
          sidebarCollapsed ? 'justify-center' : 'justify-between gap-1',
        )}
      >
        {!sidebarCollapsed && (
          <div className="flex min-w-0 items-center gap-2 overflow-hidden px-2">
            <img src={logoSvg} alt="ClawX" className="h-5 w-auto shrink-0" />
            <span className="text-sm font-semibold truncate whitespace-nowrap text-foreground/90">
              ClawX
            </span>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1">
          {!sidebarCollapsed && (
            <>
              <button
                type="button"
                data-testid="sidebar-search-button"
                aria-label={t('common:sidebar.searchSessions')}
                className="no-drag clawx-icon-button h-7 w-7 shrink-0"
                onClick={() => handleSessionSearchOpenChange(true)}
              >
                <Search className="h-4 w-4" />
              </button>
              <div ref={sidebarMoreMenuRef} className="relative">
                <button
                  type="button"
                  data-testid="sidebar-more-button"
                  aria-label={t('common:sidebar.moreSettings')}
                  aria-haspopup="menu"
                  aria-expanded={sidebarMoreMenuOpen}
                  className="no-drag clawx-icon-button h-7 w-7 shrink-0"
                  onClick={() => setSidebarMoreMenuOpen((open) => !open)}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {sidebarMoreMenuOpen && (
                  <div
                    role="menu"
                    data-testid="sidebar-more-menu"
                    aria-label={t('common:sidebar.moreSettings')}
                    className={cn(
                      'absolute right-0 top-full z-40 mt-1 w-44 rounded-lg border border-border/70 bg-surface-modal/95 p-1',
                      'text-meta text-foreground shadow-xl shadow-black/10 backdrop-blur-xl dark:shadow-black/35',
                    )}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="sidebar-batch-operation-option"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground/85 transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                      onClick={closeSidebarMoreMenu}
                    >
                      <ListChecks className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{t('common:sidebar.batchOperation')}</span>
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          <Button
            data-testid="sidebar-collapse-toggle"
            variant="ghost"
            size="icon"
            className="no-drag h-8 w-8 shrink-0 rounded-lg text-foreground/85"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            {sidebarCollapsed ? (
              <PanelLeft className="h-[18px] w-[18px]" />
            ) : (
              <PanelLeftClose className="h-[18px] w-[18px]" />
            )}
          </Button>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex flex-col gap-1 px-2">
        <button
          type="button"
          data-testid="sidebar-new-chat"
          onClick={handleNewChat}
          className={cn(
            sidebarNavItemClasses(false, sidebarCollapsed),
            'py-2',
          )}
        >
          <div className="flex shrink-0 items-center justify-center text-current [&_svg]:size-4">
            <MessageCirclePlus className="h-4 w-4" strokeWidth={2} />
          </div>
          {!sidebarCollapsed && <span className="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap">{t('sidebar.newChat')}</span>}
        </button>

        {navItems.map((item) => (
          <NavItem
            key={item.to}
            {...item}
            collapsed={sidebarCollapsed}
          />
        ))}
      </nav>

      {/* Session list — below Settings, only when expanded */}
      {!sidebarCollapsed && sessions.length > 0 && (
        <div className="mt-4 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 space-y-1">
          {sessionBuckets.map((bucket) => {
            const isBucketExpanded = expandedSessionBuckets[bucket.key] ?? false;
            return (
              <div key={bucket.key} data-testid={`session-bucket-${bucket.key}`} className="pt-2">
                <button
                  type="button"
                  data-testid={`session-bucket-toggle-${bucket.key}`}
                  aria-expanded={isBucketExpanded}
                  onClick={() => toggleSessionBucket(bucket.key)}
                  className={cn(
                    'flex w-full items-center gap-1 rounded-lg px-2.5 py-1 text-left text-tiny font-medium',
                    'text-muted-foreground/60 tracking-tight transition-colors',
                    'hover:bg-black/5 hover:text-muted-foreground dark:hover:bg-white/10',
                  )}
                >
                  <ChevronRight
                    className={cn(
                      'h-3 w-3 shrink-0 transition-transform',
                      isBucketExpanded && 'rotate-90',
                    )}
                  />
                  <span>{bucket.label}</span>
                </button>
                {isBucketExpanded && bucket.sessions.map((s) => {
                  const agentId = getAgentIdFromSessionKey(s.key);
                  const agentName = agentNameById[agentId] || agentId;
                  const isEditing = editingSessionKey === s.key;
                  const sessionLabel = getSessionLabel(s.key, s.displayName, s.label);
                  return (
                    <div
                      key={s.key}
                      data-testid={`sidebar-session-${s.key}`}
                      className="group relative flex items-center"
                      onContextMenu={(event) => handleSessionContextMenu(
                        event,
                        s.key,
                        sessionLabel,
                        Boolean(s.pinned),
                      )}
                    >
                      {isEditing ? (
                        <div className="flex w-full items-center gap-1 px-1.5 py-1">
                          <Input
                            data-testid="sidebar-session-rename-input"
                            autoFocus
                            value={editingLabel}
                            onChange={(e) => setEditingLabel(e.target.value)}
                            onKeyDown={handleRenameKeyDown}
                            onBlur={() => void handleRenameSubmit()}
                            className="h-7 min-w-0 flex-1 text-meta"
                            aria-label={t('common:sidebar.renameSessionPlaceholder')}
                          />
                          <button
                            aria-label={t('common:sidebar.saveSessionRename')}
                            onMouseDown={(e) => { e.preventDefault(); void handleRenameSubmit(); }}
                            className="clawx-icon-button h-6 w-6 shrink-0 p-0.5"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button
                            aria-label={t('common:sidebar.cancelSessionRename')}
                            onMouseDown={(e) => { e.preventDefault(); handleRenameCancel(); }}
                            className="clawx-icon-button h-6 w-6 shrink-0 p-0.5 hover:text-destructive"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            onClick={() => openSession(s.key)}
                            onDoubleClick={() => handleStartRename(s.key, sessionLabel)}
                            className={cn(
                              'clawx-nav-item w-full pr-16 text-left text-meta',
                              isOnChat && currentSessionKey === s.key
                                ? 'clawx-nav-item-active font-medium'
                                : 'text-foreground/75',
                            )}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="shrink-0 rounded-lg bg-surface-input px-2 py-0.5 text-2xs font-medium text-muted-foreground">
                                {agentName}
                              </span>
                              <span className="truncate">{sessionLabel}</span>
                              {s.pinned && (
                                <Pin
                                  aria-hidden="true"
                                  className="h-3 w-3 shrink-0 text-muted-foreground/65"
                                />
                              )}
                            </div>
                          </button>
                          <div className={cn(
                            'absolute right-1 flex items-center gap-0.5 transition-opacity',
                            'opacity-0 group-hover:opacity-100',
                          )}>
                            <button
                              aria-label={t('common:sidebar.renameSession')}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStartRename(s.key, sessionLabel);
                              }}
                              className="clawx-icon-button h-6 w-6 p-0.5"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              data-testid={`sidebar-session-delete-${s.key}`}
                              aria-label={t('common:sidebar.deleteSession')}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSessionToDelete({
                                  key: s.key,
                                  label: sessionLabel,
                                });
                                setDeleteDialogOpen(true);
                              }}
                              className="clawx-icon-button h-6 w-6 p-0.5 hover:bg-destructive/10 hover:text-destructive"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* Footer */}
      <div className="mt-auto flex flex-col gap-1 p-2">
        <div
          data-testid="sidebar-gateway-restarting"
          data-state={gatewayRestarting ? 'visible' : 'hidden'}
          aria-hidden={!gatewayRestarting}
          className={cn(
            'overflow-hidden transition-[max-height,opacity,transform] duration-200 ease-out',
            gatewayRestarting ? 'max-h-12 translate-y-0 opacity-100' : 'max-h-0 translate-y-1 opacity-0',
          )}
        >
          <div
            aria-live="polite"
            aria-label={t('common:gateway.restarting')}
            title={t('common:gateway.restarting')}
            className={cn(
              'clawx-nav-item',
              'border border-yellow-500/20 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
              'hover:bg-yellow-500/10 hover:text-yellow-700 dark:hover:bg-yellow-500/10 dark:hover:text-yellow-400',
              sidebarCollapsed && 'justify-center px-0',
            )}
          >
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            {!sidebarCollapsed && (
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {t('common:gateway.restarting')}
              </span>
            )}
          </div>
        </div>

        <NavLink
          to="/settings"
          data-testid="sidebar-nav-settings"
          className={({ isActive }) =>
            sidebarNavItemClasses(isActive, sidebarCollapsed)
          }
        >
          <>
            <div className="flex shrink-0 items-center justify-center text-current [&_svg]:size-4">
              <SettingsIcon className="h-4 w-4" strokeWidth={2} />
            </div>
            {!sidebarCollapsed && <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{t('sidebar.settings')}</span>}
          </>
        </NavLink>

        {devModeUnlocked && (
          <button
            type="button"
            data-testid="sidebar-open-dev-console"
            className={cn(
              sidebarNavItemClasses(false, sidebarCollapsed),
              'h-auto w-full',
              sidebarCollapsed ? '' : 'justify-start',
            )}
            onClick={openDevConsole}
          >
            <div className="flex shrink-0 items-center justify-center text-current [&_svg]:size-4">
              <Terminal className="h-4 w-4" strokeWidth={2} />
            </div>
            {!sidebarCollapsed && (
              <>
                <span className="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap">{t('common:sidebar.openClawPage')}</span>
                <ExternalLink className="ml-auto h-3 w-3 shrink-0 opacity-50 text-current" />
              </>
            )}
          </button>
        )}
      </div>

      {!sidebarCollapsed && (
        <div
          data-testid="sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={420}
          aria-valuenow={sidebarWidth}
          title="Drag to resize sidebar"
          onPointerDown={handleResizePointerDown}
          className="no-drag group absolute inset-y-0 right-0 z-20 w-2 translate-x-1/2 cursor-col-resize select-none"
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-primary/40"
          />
        </div>
      )}

      {sessionContextMenu && (
        <div
          ref={sessionContextMenuRef}
          role="menu"
          aria-label={t('common:sidebar.sessionContextMenu', { label: sessionContextMenu.label })}
          data-testid="sidebar-session-context-menu"
          className={cn(
            'fixed z-50 w-44 rounded-lg border border-border/70 bg-surface-modal/95 p-1',
            'text-meta text-foreground shadow-xl shadow-black/10 backdrop-blur-xl dark:shadow-black/35',
          )}
          style={{ left: contextMenuLeft, top: contextMenuTop }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            role="menuitem"
            data-testid={`sidebar-session-context-pin-${sessionContextMenu.key}`}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground/85 transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
            onClick={() => void handleContextMenuPinToggle()}
          >
            {sessionContextMenu.pinned ? (
              <PinOff className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <Pin className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">
              {sessionContextMenu.pinned
                ? t('common:sidebar.unpinSession')
                : t('common:sidebar.pinSession')}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid={`sidebar-session-context-rename-${sessionContextMenu.key}`}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground/85 transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
            onClick={() => handleStartRename(sessionContextMenu.key, sessionContextMenu.label)}
          >
            <Pencil className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t('common:sidebar.renameSession')}</span>
          </button>
        </div>
      )}

      <Dialog open={sessionSearchOpen} onOpenChange={handleSessionSearchOpenChange}>
        <DialogContent
          data-testid="sidebar-session-search-dialog"
          className="w-[calc(100vw-2rem)] max-w-lg overflow-hidden rounded-lg border border-border/70 bg-surface-modal p-0 shadow-2xl shadow-black/15 dark:shadow-black/45"
        >
          <DialogTitle className="sr-only">{t('common:sidebar.searchSessions')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('common:sidebar.searchSessionsDescription')}
          </DialogDescription>
          <div className="border-b border-border/70 p-3">
            <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-surface-input/70 px-2.5">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Input
                data-testid="sidebar-session-search-input"
                autoFocus
                value={sessionSearchQuery}
                onChange={(event) => setSessionSearchQuery(event.target.value)}
                onKeyDown={handleSessionSearchKeyDown}
                placeholder={t('common:sidebar.searchSessionsPlaceholder')}
                className="h-9 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0"
              />
            </div>
          </div>
          <div
            data-testid="sidebar-session-search-results"
            className="max-h-80 overflow-y-auto p-1.5"
          >
            {sessionSearchResults.length > 0 ? (
              sessionSearchResults.map((session) => (
                <button
                  key={session.key}
                  type="button"
                  data-testid={`sidebar-session-search-result-${session.key}`}
                  className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-black/5 focus-visible:bg-black/5 focus-visible:outline-none dark:hover:bg-white/10 dark:focus-visible:bg-white/10"
                  onClick={() => openSearchResult(session.key)}
                >
                  <span className="shrink-0 rounded-lg bg-surface-input px-2 py-0.5 text-2xs font-medium text-muted-foreground">
                    {session.agentName}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground/85">
                    {session.label}
                  </span>
                  {session.pinned && (
                    <Pin
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground/65"
                    />
                  )}
                </button>
              ))
            ) : (
              <div className="px-3 py-6 text-center text-meta text-muted-foreground">
                {t('common:sidebar.noSessionSearchResults')}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteDialogOpen}
        title={t('common:actions.confirm')}
        message={t('common:sidebar.deleteSessionConfirm', { label: sessionToDelete?.label ?? '' })}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={async () => {
          const targetSession = sessionToDelete;
          if (!targetSession) return;
          await deleteSession(targetSession.key);
          if (currentSessionKey === targetSession.key) navigate('/');
          setDeleteDialogOpen(false);
        }}
        onCancel={() => setDeleteDialogOpen(false)}
      />
    </aside>
  );
}
