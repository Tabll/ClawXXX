/**
 * Sidebar Component
 * Navigation sidebar with menu items.
 * No longer fixed - sits inside the flex layout below the title bar.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Network,
  Bot,
  Puzzle,
  Clock,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeft,
  Plus,
  Trash2,
  Pencil,
  Pin,
  PinOff,
  Check,
  X,
  Cpu,
  ImagePlus,
  Moon,
  ChevronRight,
  ChevronsUpDown,
  ChevronsDownUp,
  LoaderCircle,
  Search,
  MoreHorizontal,
  ListChecks,
  Download,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { rendererExtensionRegistry } from '@/extensions/registry';
import { useSettingsStore } from '@/stores/settings';
import { useChatStore } from '@/stores/chat';
import { useSessionAttentionStore } from '@/stores/session-attention';
import { useAgentsStore } from '@/stores/agents';
import { groupSessionsByWorkspace } from './session-buckets';
import { shouldIncludeSessionInSidebarList } from '@/stores/chat/session-key-utils';
import { CHANNEL_NAMES } from '@shared/types/channel';
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
import { formatSessionRelativeTime } from '@/lib/relative-time';
import { SIDEBAR_COLLAPSED_WIDTH, MAC_SIDEBAR_CHROME_HEIGHT } from '@shared/sidebar-layout';
import { useTranslation } from 'react-i18next';
import logoSvg from '@/assets/logo.svg';
import { useNewChatAction } from './use-new-chat-action';
import { isDefaultWorkspacePath } from '@/lib/workspace-context';
import { useWorkspaceAvailability } from '@/hooks/use-workspace-availability';
import { projectSessionRunState } from '@/stores/chat/session-status';
import { getSessionDisplayTitle } from '@shared/chat/session-title';
import { KernelStatusStrip } from '@/components/kernels/KernelStatus';
import { kernelDisplayName, kernelOptionsFor, useKernelStore } from '@/stores/kernels';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  collapsed?: boolean;
  onClick?: () => void;
  testId?: string;
}

function NavItem({ to, icon, label, badge, collapsed, onClick, testId }: NavItemProps) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      data-testid={testId}
      className={({ isActive }) =>
        cn(
          'sidebar-nav-text flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors',
          'hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80',
          isActive ? 'bg-black/5 dark:bg-white/10 text-foreground' : '',
          collapsed && 'justify-center px-0',
        )
      }
    >
      <>
        <div className="flex shrink-0 items-center justify-center text-current [&_svg]:size-4">{icon}</div>
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
const INITIAL_WORKSPACE_SESSION_LIMIT = 5;
const WORKSPACE_SESSION_LIMIT_INCREMENT = 5;

function getWorkspaceTestIdSegment(workspacePath: string): string {
  return encodeURIComponent(workspacePath.trim() || 'workspace');
}

export function getWorkspaceGroupStateKey(workspacePath: string): string {
  return workspacePath;
}

export function getWorkspaceGroupTestId(workspacePath: string): string {
  return `workspace-session-group-${getWorkspaceTestIdSegment(workspacePath)}`;
}

export function getWorkspaceGroupToggleTestId(workspacePath: string): string {
  return `workspace-session-group-toggle-${getWorkspaceTestIdSegment(workspacePath)}`;
}

export function getWorkspaceGroupRenameTestId(workspacePath: string): string {
  return `workspace-session-group-rename-${getWorkspaceTestIdSegment(workspacePath)}`;
}

function getWorkspaceGroupDeleteTestId(workspacePath: string): string {
  return `workspace-session-group-delete-${getWorkspaceTestIdSegment(workspacePath)}`;
}

function getWorkspaceLoadMoreTestId(workspacePath: string): string {
  return `workspace-session-load-more-${getWorkspaceTestIdSegment(workspacePath)}`;
}

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
  const chatWorkspacePath = useSettingsStore((state) => state.chatWorkspacePath);
  const recentWorkspacePaths = useSettingsStore((state) => state.recentWorkspacePaths);
  const workspaceLabels = useSettingsStore((state) => state.workspaceLabels);
  const setWorkspaceLabel = useSettingsStore((state) => state.setWorkspaceLabel);
  const removeWorkspace = useSettingsStore((state) => state.removeWorkspace);
  const [isResizing, setIsResizing] = useState(false);
  const stopResizeRef = useRef<(() => void) | null>(null);

  const sessions = useChatStore((s) => s.sessions);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessionLabels = useChatStore((s) => s.sessionLabels);
  const sessionLastActivity = useChatStore((s) => s.sessionLastActivity);
  const switchSession = useChatStore((s) => s.switchSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const deleteSessions = useChatStore((s) => s.deleteSessions);
  const renameSession = useChatStore((s) => s.renameSession);
  const setSessionPinned = useChatStore((s) => s.setSessionPinned);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const loadMoreSessions = useChatStore((s) => s.loadMoreSessions);
  const searchSessions = useChatStore((s) => s.searchSessions);
  const exportSession = useChatStore((s) => s.exportSession);
  const sessionNextCursor = useChatStore((s) => s.sessionNextCursor);
  const sessionCatalogLoading = useChatStore((s) => s.sessionCatalogLoading);
  const kernelCatalog = useKernelStore((s) => s.catalog);
  const sessionAttentionByKey = useSessionAttentionStore((s) => s.bySessionKey);
  const markRead = useSessionAttentionStore((s) => s.markRead);
  const handleNewChat = useNewChatAction();

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  useEffect(() => {
    if (!isMac) return;
    void hostApi.window.syncTrafficLightPosition(sidebarCollapsed);
  }, [isMac, sidebarCollapsed]);

  const navigate = useNavigate();
  const isOnChat = useLocation().pathname === '/';

  const { t, i18n } = useTranslation(['common', 'chat']);
  const [sessionToDelete, setSessionToDelete] = useState<{ key: string; label: string } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<{
    path: string;
    label: string;
    sessionKeys: string[];
  } | null>(null);
  const [workspaceDeleteDialogOpen, setWorkspaceDeleteDialogOpen] = useState(false);
  const [editingSessionKey, setEditingSessionKey] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [editingOriginalLabel, setEditingOriginalLabel] = useState('');
  const [editingWorkspacePath, setEditingWorkspacePath] = useState<string | null>(null);
  const [editingWorkspaceLabel, setEditingWorkspaceLabel] = useState('');
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
  const [sessionSearchResponse, setSessionSearchResponse] = useState<{
    criteriaKey: string;
    keys: string[];
  } | null>(null);
  const [sessionSearchLoadingCriteria, setSessionSearchLoadingCriteria] = useState<string | null>(null);
  const [sessionKernelFilter, setSessionKernelFilter] = useState('');
  const [sessionKernelScope, setSessionKernelScope] = useState<'last' | 'participated'>('last');
  const [sessionAgentFilter, setSessionAgentFilter] = useState('');
  const [sessionSourceFilter, setSessionSourceFilter] = useState('');
  const [sessionWorkspaceFilter, setSessionWorkspaceFilter] = useState('');
  const [sessionAttentionFilter, setSessionAttentionFilter] = useState<'all' | 'busy' | 'unread'>('all');
  const [batchMode, setBatchMode] = useState(false);
  const [selectedSessionKeys, setSelectedSessionKeys] = useState<Set<string>>(() => new Set());
  const [batchDeleteDialogOpen, setBatchDeleteDialogOpen] = useState(false);
  const [nowMs, setNowMs] = useState(INITIAL_NOW_MS);
  const [collapsedWorkspaceGroups, setCollapsedWorkspaceGroups] = useState<Record<string, boolean>>({});
  const [workspaceVisibleSessionCounts, setWorkspaceVisibleSessionCounts] = useState<Record<string, number>>({});

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

  useEffect(() => {
    if (workspaceDeleteDialogOpen || !workspaceToDelete) return;
    const timer = window.setTimeout(() => setWorkspaceToDelete(null), 160);
    return () => window.clearTimeout(timer);
  }, [workspaceDeleteDialogOpen, workspaceToDelete]);

  const closeSessionContextMenu = useCallback(() => setSessionContextMenu(null), []);
  const closeSidebarMoreMenu = useCallback(() => setSidebarMoreMenuOpen(false), []);

  useEffect(() => {
    if (!sessionContextMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target && sessionContextMenuRef.current?.contains(event.target as Node)) return;
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
      if (event.target && sidebarMoreMenuRef.current?.contains(event.target as Node)) return;
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
    setEditingOriginalLabel(currentLabel);
  };

  const handleSessionContextMenu = (
    event: React.MouseEvent,
    key: string,
    label: string,
    pinned: boolean,
  ) => {
    if (batchMode) return;
    event.preventDefault();
    event.stopPropagation();
    closeSidebarMoreMenu();
    setSessionContextMenu({ key, label, pinned, x: event.clientX, y: event.clientY });
  };

  const handleContextMenuPinToggle = async () => {
    const target = sessionContextMenu;
    if (!target) return;
    closeSessionContextMenu();
    try {
      await setSessionPinned(target.key, !target.pinned);
    } catch (error) {
      console.error('Failed to update session pin state:', error);
      toast.error(t('common:sidebar.pinSessionFailed'));
    }
  };

  const handleContextMenuExport = async () => {
    const target = sessionContextMenu;
    if (!target) return;
    closeSessionContextMenu();
    const result = await exportSession(target.key);
    if (result.success) toast.success(t('common:sidebar.exportSessionSuccess'));
    else toast.error(t('common:sidebar.exportSessionFailed', { error: result.error }));
  };

  const handleSessionSearchOpenChange = useCallback((open: boolean) => {
    setSessionSearchOpen(open);
    if (!open) {
      setSessionSearchQuery('');
      setSessionSearchResponse(null);
      setSessionSearchLoadingCriteria(null);
      setSessionKernelFilter('');
      setSessionKernelScope('last');
      setSessionAgentFilter('');
      setSessionSourceFilter('');
      setSessionWorkspaceFilter('');
      setSessionAttentionFilter('all');
    }
  }, []);

  const exitBatchMode = useCallback(() => {
    setBatchMode(false);
    setSelectedSessionKeys(new Set());
    setBatchDeleteDialogOpen(false);
  }, []);

  const toggleBatchSelection = useCallback((sessionKey: string) => {
    setSelectedSessionKeys((current) => {
      const next = new Set(current);
      if (next.has(sessionKey)) next.delete(sessionKey);
      else next.add(sessionKey);
      return next;
    });
  }, []);

  const handleRenameSubmit = async () => {
    const normalizedLabel = editingLabel.trim();
    if (!editingSessionKey || !normalizedLabel || normalizedLabel === editingOriginalLabel.trim()) {
      setEditingSessionKey(null);
      setEditingOriginalLabel('');
      return;
    }
    try {
      await renameSession(editingSessionKey, normalizedLabel);
    } catch (err) {
      console.error('Failed to rename session:', err);
    }
    setEditingSessionKey(null);
    setEditingOriginalLabel('');
  };

  const handleRenameCancel = () => {
    setEditingSessionKey(null);
    setEditingOriginalLabel('');
  };

  const handleRenameBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    void handleRenameSubmit();
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleRenameSubmit();
    } else if (e.key === 'Escape') {
      handleRenameCancel();
    }
  };

  const handleStartWorkspaceRename = (workspacePath: string, currentLabel: string) => {
    setEditingWorkspacePath(workspacePath);
    setEditingWorkspaceLabel(currentLabel);
  };

  const handleWorkspaceRenameSubmit = () => {
    if (editingWorkspacePath && editingWorkspaceLabel.trim()) {
      setWorkspaceLabel(editingWorkspacePath, editingWorkspaceLabel);
    }
    setEditingWorkspacePath(null);
  };

  const handleWorkspaceRenameCancel = () => {
    setEditingWorkspacePath(null);
  };

  const handleWorkspaceRenameBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    handleWorkspaceRenameSubmit();
  };

  const handleWorkspaceRenameKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleWorkspaceRenameSubmit();
    } else if (event.key === 'Escape') {
      handleWorkspaceRenameCancel();
    }
  };

  const toggleWorkspaceGroup = (workspacePath: string) => {
    const stateKey = getWorkspaceGroupStateKey(workspacePath);
    setCollapsedWorkspaceGroups((current) => ({
      ...current,
      [stateKey]: !(current[stateKey] ?? false),
    }));
  };

  const loadMoreWorkspaceSessions = (workspacePath: string) => {
    const stateKey = getWorkspaceGroupStateKey(workspacePath);
    setWorkspaceVisibleSessionCounts((current) => ({
      ...current,
      [stateKey]: (current[stateKey] ?? INITIAL_WORKSPACE_SESSION_LIMIT) + WORKSPACE_SESSION_LIMIT_INCREMENT,
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
  const kernelOptions = useMemo(() => kernelOptionsFor(
    kernelCatalog,
    sessions.flatMap(session => [
      ...(session.kernelId ? [session.kernelId] : []),
      ...(session.kernelIds ?? []),
    ]),
  ), [kernelCatalog, sessions]);
  const sidebarSessions = useMemo(
    () => sessions.filter((session) => shouldIncludeSessionInSidebarList(session)),
    [sessions],
  );
  const defaultWorkspaceLabel = t('chat:workspace.defaultLabel');
  const workspaceSessionGroups = useMemo(() => groupSessionsByWorkspace(
    sidebarSessions,
    sessionLastActivity,
    defaultWorkspaceLabel,
    chatWorkspacePath,
    workspaceLabels,
    [
      ...recentWorkspacePaths,
      chatWorkspacePath,
      ...sessions.map((session) => session.workspacePath).filter((path): path is string => !!path),
    ],
  ).map((group) => ({
    ...group,
    sessions: [...group.sessions].sort((a, b) => {
      const pinnedOrder = Number(Boolean(b.session.pinned)) - Number(Boolean(a.session.pinned));
      return pinnedOrder || b.activityMs - a.activityMs;
    }),
  })), [
    chatWorkspacePath,
    defaultWorkspaceLabel,
    recentWorkspacePaths,
    sessionLastActivity,
    sessions,
    sidebarSessions,
    workspaceLabels,
  ]);
  const workspacePaths = useMemo(
    () => workspaceSessionGroups.map((group) => group.workspacePath),
    [workspaceSessionGroups],
  );
  const workspaceAvailability = useWorkspaceAvailability(workspacePaths);
  const allWorkspaceGroupsCollapsed = workspaceSessionGroups.length > 0
    && workspaceSessionGroups.every((group) => collapsedWorkspaceGroups[getWorkspaceGroupStateKey(group.workspacePath)] ?? false);

  const toggleAllWorkspaceGroups = () => {
    const nextCollapsed = !allWorkspaceGroupsCollapsed;
    setCollapsedWorkspaceGroups((current) => {
      const next = { ...current };
      for (const group of workspaceSessionGroups) {
        next[getWorkspaceGroupStateKey(group.workspacePath)] = nextCollapsed;
      }
      return next;
    });
  };

  const openSession = useCallback((sessionKey: string) => {
    markRead(sessionKey);
    if (currentSessionKey !== sessionKey) switchSession(sessionKey);
    navigate('/');
  }, [currentSessionKey, markRead, navigate, switchSession]);

  const enterBatchMode = useCallback(() => {
    closeSidebarMoreMenu();
    closeSessionContextMenu();
    setCollapsedWorkspaceGroups(Object.fromEntries(
      workspaceSessionGroups.map((group) => [getWorkspaceGroupStateKey(group.workspacePath), false]),
    ));
    setWorkspaceVisibleSessionCounts(Object.fromEntries(
      workspaceSessionGroups.map((group) => [
        getWorkspaceGroupStateKey(group.workspacePath),
        group.sessions.length,
      ]),
    ));
    setBatchMode(true);
  }, [closeSessionContextMenu, closeSidebarMoreMenu, workspaceSessionGroups]);

  const handleBatchDeleteConfirm = async () => {
    const availableSessionKeys = new Set(sidebarSessions.map((session) => session.key));
    const sessionKeys = [...selectedSessionKeys].filter((key) => availableSessionKeys.has(key));
    if (sessionKeys.length === 0) return;
    const currentWasSelected = sessionKeys.includes(currentSessionKey);
    const result = await deleteSessions(sessionKeys);
    setBatchDeleteDialogOpen(false);
    if (currentWasSelected && result.deletedKeys.includes(currentSessionKey)) navigate('/');
    if (result.failedKeys.length > 0) {
      setSelectedSessionKeys(new Set(result.failedKeys));
      toast.error(t('common:sidebar.batchDeletePartialFailure', { count: result.failedKeys.length }));
      return;
    }
    exitBatchMode();
  };

  const searchableSessions = useMemo(() => {
    const workspaceBySessionKey = new Map<string, string>();
    for (const group of workspaceSessionGroups) {
      for (const entry of group.sessions) workspaceBySessionKey.set(entry.session.key, group.label);
    }
    return sidebarSessions.map((session) => {
      const agentId = session.agentId || getAgentIdFromSessionKey(session.key);
      const agentName = agentNameById[agentId] || agentId;
      const label = getSessionDisplayTitle(session, sessionLabels);
      const workspaceLabel = workspaceBySessionKey.get(session.key) ?? '';
      const channelType = session.channel && session.channel !== 'webchat' ? session.channel : '';
      const channelName = channelType
        ? (CHANNEL_NAMES[channelType as keyof typeof CHANNEL_NAMES] ?? channelType)
        : '';
      return {
        key: session.key,
        label,
        agentName,
        workspaceLabel,
        channelName,
        kernelId: session.kernelId,
        kernelIds: session.kernelIds ?? (session.kernelId ? [session.kernelId] : []),
        workspacePath: session.workspacePath ?? '',
        attention: sessionAttentionByKey[session.key],
        pinned: Boolean(session.pinned),
        activityMs: sessionLastActivity[session.key] ?? session.updatedAt ?? 0,
        searchText: [
          label,
          session.label,
          session.displayName,
          session.derivedTitle,
          session.key,
          agentName,
          workspaceLabel,
          channelName,
          session.kernelId ? kernelDisplayName(session.kernelId) : '',
          ...(session.kernelIds ?? []).map(kernelDisplayName),
        ].filter(Boolean).join(' ').toLowerCase(),
      };
    }).sort((a, b) => {
      const pinnedOrder = Number(b.pinned) - Number(a.pinned);
      return pinnedOrder || b.activityMs - a.activityMs;
    });
  }, [agentNameById, sessionAttentionByKey, sessionLabels, sessionLastActivity, sidebarSessions, workspaceSessionGroups]);

  const normalizedSessionSearchQuery = sessionSearchQuery.trim().toLowerCase();
  const hasServerSearchCriteria = Boolean(
    normalizedSessionSearchQuery || sessionKernelFilter || sessionAgentFilter || sessionSourceFilter,
  );
  const sessionSearchCriteriaKey = JSON.stringify([
    normalizedSessionSearchQuery,
    sessionKernelFilter,
    sessionKernelScope,
    sessionAgentFilter,
    sessionSourceFilter,
  ]);
  useEffect(() => {
    if (!sessionSearchOpen || !hasServerSearchCriteria) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSessionSearchLoadingCriteria(sessionSearchCriteriaKey);
      void searchSessions(normalizedSessionSearchQuery, {
        ...(sessionKernelFilter && sessionKernelScope === 'last'
          ? { lastKernelId: sessionKernelFilter }
          : {}),
        ...(sessionKernelFilter && sessionKernelScope === 'participated'
          ? { participatedKernelId: sessionKernelFilter }
          : {}),
        ...(sessionAgentFilter ? { agentId: sessionAgentFilter } : {}),
        ...(sessionSourceFilter ? { sourceChannel: sessionSourceFilter } : {}),
      }).then(results => {
        if (!cancelled) {
          setSessionSearchResponse({
            criteriaKey: sessionSearchCriteriaKey,
            keys: results.map(result => result.key),
          });
        }
      }).catch(error => {
        if (!cancelled) {
          setSessionSearchResponse({ criteriaKey: sessionSearchCriteriaKey, keys: [] });
          toast.error(t('common:sidebar.searchSessionsFailed', { error: String(error) }));
        }
      }).finally(() => {
        if (!cancelled) {
          setSessionSearchLoadingCriteria(current => (
            current === sessionSearchCriteriaKey ? null : current
          ));
        }
      });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    hasServerSearchCriteria,
    normalizedSessionSearchQuery,
    searchSessions,
    sessionAgentFilter,
    sessionKernelFilter,
    sessionKernelScope,
    sessionSearchCriteriaKey,
    sessionSearchOpen,
    sessionSourceFilter,
    t,
  ]);

  const sessionSearchKeys = sessionSearchResponse?.criteriaKey === sessionSearchCriteriaKey
    ? sessionSearchResponse.keys
    : null;
  const sessionSearchLoading = sessionSearchLoadingCriteria === sessionSearchCriteriaKey;
  const sessionSearchResults = useMemo(() => {
    const byKey = new Map(searchableSessions.map(session => [session.key, session] as const));
    const serverOrdered = sessionSearchKeys?.flatMap(key => {
      const session = byKey.get(key);
      return session ? [session] : [];
    });
    const matches = serverOrdered ?? (normalizedSessionSearchQuery
      ? searchableSessions.filter((session) => session.searchText.includes(normalizedSessionSearchQuery))
      : searchableSessions);
    const filtered = matches.filter(session => (
      (!sessionWorkspaceFilter || session.workspacePath === sessionWorkspaceFilter)
      && (sessionAttentionFilter === 'all'
        || (sessionAttentionFilter === 'busy'
          ? session.attention?.observedBusy === true
          : session.attention?.unread === true))
    ));
    return filtered.slice(0, hasServerSearchCriteria ? 50 : 12);
  }, [
    hasServerSearchCriteria,
    normalizedSessionSearchQuery,
    searchableSessions,
    sessionAttentionFilter,
    sessionSearchKeys,
    sessionWorkspaceFilter,
  ]);

  const openSearchResult = useCallback((sessionKey: string) => {
    openSession(sessionKey);
    handleSessionSearchOpenChange(false);
  }, [handleSessionSearchOpenChange, openSession]);

  const handleSessionSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || !sessionSearchResults[0]) return;
    event.preventDefault();
    openSearchResult(sessionSearchResults[0].key);
  };

  const contextMenuLeft = sessionContextMenu
    ? Math.min(sessionContextMenu.x, Math.max(8, window.innerWidth - 188))
    : 0;
  const contextMenuTop = sessionContextMenu
    ? Math.min(sessionContextMenu.y, Math.max(8, window.innerHeight - 92))
    : 0;
  const availableSessionKeys = new Set(sidebarSessions.map((session) => session.key));
  const selectedSessionCount = [...selectedSessionKeys]
    .filter((sessionKey) => availableSessionKeys.has(sessionKey))
    .length;

  const hiddenRoutes = rendererExtensionRegistry.getHiddenRoutes();
  const extraNavItems = rendererExtensionRegistry.getExtraNavItems();

  const coreNavItems = [
    {
      to: '/models',
      icon: <Cpu className="h-4 w-4" strokeWidth={2} />,
      label: t('sidebar.models'),
      testId: 'sidebar-nav-models',
    },
    {
      to: '/agents',
      icon: <Bot className="h-4 w-4" strokeWidth={2} />,
      label: t('sidebar.agents'),
      testId: 'sidebar-nav-agents',
    },
    {
      to: '/channels',
      icon: <Network className="h-4 w-4" strokeWidth={2} />,
      label: t('sidebar.channels'),
      testId: 'sidebar-nav-channels',
    },
    {
      to: '/skills',
      icon: <Puzzle className="h-4 w-4" strokeWidth={2} />,
      label: t('sidebar.skills'),
      testId: 'sidebar-nav-skills',
    },
    {
      to: '/cron',
      icon: <Clock className="h-4 w-4" strokeWidth={2} />,
      label: t('sidebar.cronTasks'),
      testId: 'sidebar-nav-cron',
    },
    ...(devModeUnlocked
      ? [
          {
            to: '/image-generation',
            icon: <ImagePlus className="h-4 w-4" strokeWidth={2} />,
            label: t('common:sidebar.imageGeneration'),
            testId: 'sidebar-nav-image-generation',
          },
          {
            to: '/dreams',
            icon: <Moon className="h-4 w-4" strokeWidth={2} />,
            label: t('common:sidebar.openClawDreams'),
            testId: 'sidebar-nav-dreams',
          },
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
        className={cn('flex shrink-0 items-center p-2 h-8', sidebarCollapsed ? 'justify-center' : 'justify-between')}
      >
        {!sidebarCollapsed && (
          <div className="flex items-center gap-2 px-2 overflow-hidden">
            <img src={logoSvg} alt="ClawX" className="h-5 w-auto shrink-0" />
            <span className="text-sm font-semibold truncate whitespace-nowrap text-foreground/90">ClawX</span>
          </div>
        )}
        <Button
          data-testid="sidebar-collapse-toggle"
          variant="ghost"
          size="icon"
          className={cn(
            'no-drag h-8 w-8 shrink-0 rounded-lg text-foreground/80',
            'hover:bg-black/5 hover:text-foreground/80 dark:hover:bg-white/5',
          )}
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        >
          {sidebarCollapsed ? (
            <PanelLeft className="h-[18px] w-[18px]" />
          ) : (
            <PanelLeftClose className="h-[18px] w-[18px]" />
          )}
        </Button>
      </div>

      {/* Navigation */}
      <nav className="flex flex-col gap-1 px-2 mt-2">
        <button
          type="button"
          data-testid="sidebar-new-chat"
          onClick={handleNewChat}
          className={cn(
            'sidebar-nav-text flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors',
            'hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80',
            sidebarCollapsed && 'justify-center px-0',
          )}
        >
          <div className="flex shrink-0 items-center justify-center text-current [&_svg]:size-4">
            <Plus className="h-4 w-4" strokeWidth={2} />
          </div>
          {!sidebarCollapsed && (
            <span className="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap">
              {t('sidebar.newChat')}
            </span>
          )}
        </button>

        {navItems.map((item) => (
          <NavItem key={item.to} {...item} collapsed={sidebarCollapsed} />
        ))}
      </nav>

      {/* Session list — below Settings, only when expanded */}
      {!sidebarCollapsed && sidebarSessions.length > 0 && (
        <div className="mt-4 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2">
          <div className="mb-1 flex items-center justify-between gap-2 pl-2.5">
            <span className="text-tiny font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
              {t('chat:sessionList.title')}
            </span>
            {batchMode ? (
              <div data-testid="sidebar-batch-toolbar" className="flex shrink-0 items-center gap-1">
                <span
                  data-testid="sidebar-batch-selected-count"
                  className="max-w-20 truncate px-1 text-2xs font-medium text-muted-foreground"
                >
                  {t('common:sidebar.selectedSessionsCount', { count: selectedSessionCount })}
                </span>
                <button
                  type="button"
                  data-testid="sidebar-batch-delete-button"
                  aria-label={t('common:sidebar.batchDeleteSessions')}
                  disabled={selectedSessionCount === 0}
                  onClick={() => {
                    if (selectedSessionCount > 0) setBatchDeleteDialogOpen(true);
                  }}
                  className={cn(
                    'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors',
                    selectedSessionCount > 0
                      ? 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
                      : 'cursor-not-allowed text-muted-foreground/40',
                  )}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  data-testid="sidebar-batch-cancel-button"
                  aria-label={t('common:sidebar.exitBatchOperation')}
                  onClick={exitBatchMode}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  data-testid="sidebar-search-button"
                  aria-label={t('common:sidebar.searchSessions')}
                  title={t('common:sidebar.searchSessions')}
                  onClick={() => handleSessionSearchOpenChange(true)}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                >
                  <Search className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  data-testid="session-list-toggle-all"
                  aria-label={allWorkspaceGroupsCollapsed ? t('chat:sessionList.expandAll') : t('chat:sessionList.collapseAll')}
                  title={allWorkspaceGroupsCollapsed ? t('chat:sessionList.expandAll') : t('chat:sessionList.collapseAll')}
                  onClick={toggleAllWorkspaceGroups}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                >
                  <span aria-hidden="true" className="flex h-3.5 w-3.5 items-center justify-center">
                    {allWorkspaceGroupsCollapsed ? (
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronsDownUp className="h-3.5 w-3.5" />
                    )}
                  </span>
                </button>
                <div ref={sidebarMoreMenuRef} className="relative">
                  <button
                    type="button"
                    data-testid="sidebar-more-button"
                    aria-label={t('common:sidebar.moreSettings')}
                    aria-haspopup="menu"
                    aria-expanded={sidebarMoreMenuOpen}
                    onClick={() => setSidebarMoreMenuOpen((open) => !open)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                  {sidebarMoreMenuOpen && (
                    <div
                      role="menu"
                      data-testid="sidebar-more-menu"
                      aria-label={t('common:sidebar.moreSettings')}
                      onPointerDown={(event) => event.stopPropagation()}
                      className="absolute right-0 top-full z-40 mt-1 w-44 rounded-lg border border-border/70 bg-surface-modal p-1 text-meta text-foreground shadow-xl shadow-black/10 dark:shadow-black/35"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="sidebar-batch-operation-option"
                        onClick={enterBatchMode}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground/85 transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                      >
                        <ListChecks className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{t('common:sidebar.batchOperation')}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            {workspaceSessionGroups.map((workspaceGroup) => {
              const workspaceStateKey = getWorkspaceGroupStateKey(workspaceGroup.workspacePath);
              const collapsed = collapsedWorkspaceGroups[workspaceStateKey] ?? false;
              const visibleCount = workspaceVisibleSessionCounts[workspaceStateKey] ?? INITIAL_WORKSPACE_SESSION_LIMIT;
              const visibleSessions = workspaceGroup.sessions.slice(0, visibleCount);
              const hiddenCount = Math.max(0, workspaceGroup.sessions.length - visibleSessions.length);
              const loadMoreCount = Math.min(WORKSPACE_SESSION_LIMIT_INCREMENT, hiddenCount);
              const workspaceUnavailable = workspaceAvailability[workspaceGroup.workspacePath] === 'unavailable'
                && !isDefaultWorkspacePath(workspaceGroup.workspacePath);

              return (
                <div
                  key={workspaceGroup.workspacePath}
                  data-testid={getWorkspaceGroupTestId(workspaceGroup.workspacePath)}
                  className="space-y-1"
                >
                  {editingWorkspacePath === workspaceGroup.workspacePath ? (
                    <div
                      className="flex w-full items-center gap-1 px-1.5 py-1"
                      onBlur={handleWorkspaceRenameBlur}
                    >
                      <Input
                        autoFocus
                        value={editingWorkspaceLabel}
                        onChange={(event) => setEditingWorkspaceLabel(event.target.value)}
                        onKeyDown={handleWorkspaceRenameKeyDown}
                        className="h-7 min-w-0 flex-1 text-meta"
                        aria-label={t('chat:sessionList.workspaceName')}
                      />
                      <button
                        type="button"
                        aria-label={t('chat:sessionList.saveWorkspaceRename')}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={handleWorkspaceRenameSubmit}
                        className="flex shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground hover:text-foreground"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={t('chat:sessionList.cancelWorkspaceRename')}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={handleWorkspaceRenameCancel}
                        className="flex shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="group flex items-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5">
                      <button
                        type="button"
                        data-testid={getWorkspaceGroupToggleTestId(workspaceGroup.workspacePath)}
                        aria-expanded={!collapsed}
                        aria-label={t('chat:sessionList.workspaceToggle', { workspace: workspaceGroup.label })}
                        onClick={() => toggleWorkspaceGroup(workspaceGroup.workspacePath)}
                        onDoubleClick={() => {
                          if (!isDefaultWorkspacePath(workspaceGroup.workspacePath)) {
                            handleStartWorkspaceRename(workspaceGroup.workspacePath, workspaceGroup.label);
                          }
                        }}
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-meta font-semibold text-foreground/75 transition-colors hover:text-foreground"
                        title={workspaceGroup.workspacePath}
                      >
                        <ChevronRight
                          className={cn(
                            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                            !collapsed && 'rotate-90',
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">{workspaceGroup.label}</span>
                        {workspaceUnavailable && (
                          <Badge
                            variant="warning"
                            data-testid={`workspace-session-group-unavailable-${getWorkspaceTestIdSegment(workspaceGroup.workspacePath)}`}
                            className="shrink-0 px-1.5 py-0 text-2xs"
                          >
                            {t('chat:sessionList.workspaceUnavailableBadge')}
                          </Badge>
                        )}
                        <span className="shrink-0 text-2xs font-medium text-muted-foreground/60 group-hover:hidden group-focus-within:hidden">
                          {workspaceGroup.sessions.length}
                        </span>
                      </button>
                      {!isDefaultWorkspacePath(workspaceGroup.workspacePath) && (
                        <button
                          type="button"
                          data-testid={getWorkspaceGroupRenameTestId(workspaceGroup.workspacePath)}
                          aria-label={t('chat:sessionList.renameWorkspace', { workspace: workspaceGroup.label })}
                          title={t('chat:sessionList.renameWorkspace', { workspace: workspaceGroup.label })}
                          onClick={() => handleStartWorkspaceRename(workspaceGroup.workspacePath, workspaceGroup.label)}
                          className={cn(
                            'hidden shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-black/5 hover:text-foreground group-hover:flex group-focus-within:flex dark:hover:bg-white/10',
                            !workspaceUnavailable && 'mr-2',
                          )}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {workspaceUnavailable && (
                        <button
                          type="button"
                          data-testid={getWorkspaceGroupDeleteTestId(workspaceGroup.workspacePath)}
                          aria-label={t('chat:sessionList.deleteWorkspace', { workspace: workspaceGroup.label })}
                          title={t('chat:sessionList.deleteWorkspace', { workspace: workspaceGroup.label })}
                          onClick={(event) => {
                            event.stopPropagation();
                            setWorkspaceToDelete({
                              path: workspaceGroup.workspacePath,
                              label: workspaceGroup.label,
                              sessionKeys: workspaceGroup.sessions.map(({ session }) => session.key),
                            });
                            setWorkspaceDeleteDialogOpen(true);
                          }}
                          className="mr-2 flex shrink-0 items-center justify-center rounded p-0.5 text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  )}

                  {!collapsed && (
                    <div className="space-y-0.5">
                      {visibleSessions.map(({ session: s, activityMs }) => {
                        const agentId = s.agentId || getAgentIdFromSessionKey(s.key);
                        const agentName = agentNameById[agentId] || agentId;
                        const isEditing = editingSessionKey === s.key;
                        const isCurrentSession = isOnChat && currentSessionKey === s.key;
                        const sessionLabel = getSessionDisplayTitle(s, sessionLabels);
                        const relativeTime = formatSessionRelativeTime(activityMs, nowMs, i18n.language);
                        const runState = projectSessionRunState(s);
                        const attention = sessionAttentionByKey[s.key];
                        const isBusy = runState === 'busy'
                          || (runState === 'unknown' && attention?.observedBusy === true);
                        const isUnread = !isBusy && attention?.unread === true;
                        const channelType = s.channel && s.channel !== 'webchat' ? s.channel : null;
                        const channelName = channelType
                          ? (CHANNEL_NAMES[channelType as keyof typeof CHANNEL_NAMES] ?? channelType)
                          : null;

                        return (
                          <div
                            key={s.key}
                            onContextMenu={(event) => handleSessionContextMenu(
                              event,
                              s.key,
                              sessionLabel,
                              Boolean(s.pinned),
                            )}
                            className={cn(
                              'group flex items-center rounded-lg transition-colors',
                              'hover:bg-black/5 focus-within:bg-black/5 dark:hover:bg-white/5 dark:focus-within:bg-white/5',
                              !isEditing && isCurrentSession
                                ? 'bg-black/5 dark:bg-white/10'
                                : '',
                            )}
                          >
                            {batchMode ? (
                              <label
                                data-testid={`sidebar-session-${s.key}`}
                                className={cn(
                                  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-meta transition-colors',
                                  selectedSessionKeys.has(s.key)
                                    ? 'bg-black/5 font-medium text-foreground dark:bg-white/10'
                                    : 'text-foreground/75',
                                )}
                              >
                                <input
                                  type="checkbox"
                                  data-testid={`sidebar-session-select-${s.key}`}
                                  checked={selectedSessionKeys.has(s.key)}
                                  onChange={() => toggleBatchSelection(s.key)}
                                  aria-label={t('common:sidebar.toggleSessionSelection', { label: sessionLabel })}
                                  className="h-3.5 w-3.5 shrink-0 rounded border-border accent-primary"
                                />
                                <span className="shrink-0 rounded-full bg-black/[0.04] px-2 py-0.5 text-2xs font-medium text-foreground/70 dark:bg-white/[0.08]">
                                  {agentName}
                                </span>
                                {s.kernelId && (
                                  <span className="shrink-0 rounded-full bg-violet-500/10 px-2 py-0.5 text-2xs font-medium text-violet-700 dark:text-violet-400">
                                    {kernelDisplayName(s.kernelId)}
                                  </span>
                                )}
                                <span className="min-w-0 flex-1 truncate">{sessionLabel}</span>
                                {s.pinned && <Pin aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />}
                              </label>
                            ) : isEditing ? (
                              <div className="flex w-full items-center gap-1 px-1.5 py-1" onBlur={handleRenameBlur}>
                                <Input
                                  data-testid="sidebar-session-rename-input"
                                  autoFocus
                                  value={editingLabel}
                                  onChange={(e) => setEditingLabel(e.target.value)}
                                  onKeyDown={handleRenameKeyDown}
                                  className="h-7 min-w-0 flex-1 text-meta"
                                  aria-label={t('common:sidebar.renameSessionPlaceholder')}
                                />
                                <button
                                  type="button"
                                  aria-label={t('common:sidebar.saveSessionRename')}
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => void handleRenameSubmit()}
                                  className="flex shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground hover:text-foreground"
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  aria-label={t('common:sidebar.cancelSessionRename')}
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={handleRenameCancel}
                                  className="flex shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground hover:text-destructive"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ) : (
                              <>
                                <button
                                  data-testid={`sidebar-session-${s.key}`}
                                  aria-current={isCurrentSession ? 'page' : undefined}
                                  onClick={() => openSession(s.key)}
                                  onDoubleClick={() => handleStartRename(s.key, sessionLabel)}
                                  className={cn(
                                    'flex-1 min-w-0 text-left px-2.5 py-1.5 text-meta',
                                    isCurrentSession
                                      ? 'text-foreground font-medium'
                                      : 'text-foreground/75',
                                  )}
                                >
                                  <div className="flex min-w-0 items-center gap-2">
                                    <span className="shrink-0 rounded-full bg-black/[0.04] px-2 py-0.5 text-2xs font-medium text-foreground/70 dark:bg-white/[0.08]">
                                      {agentName}
                                    </span>
                                    {channelType && channelName && (
                                      <span
                                        title={channelName}
                                        aria-label={channelName}
                                        className="shrink-0 truncate rounded-full bg-blue-500/10 px-2 py-0.5 text-2xs font-medium text-blue-700 dark:bg-blue-400/10 dark:text-blue-400"
                                      >
                                        {channelName}
                                      </span>
                                    )}
                                    {s.kernelId && (
                                      <span
                                        data-testid={`sidebar-session-kernel-${s.key}`}
                                        title={t('common:sidebar.lastKernel', { kernel: kernelDisplayName(s.kernelId) })}
                                        className="shrink-0 truncate rounded-full bg-violet-500/10 px-2 py-0.5 text-2xs font-medium text-violet-700 dark:text-violet-400"
                                      >
                                        {kernelDisplayName(s.kernelId)}
                                      </span>
                                    )}
                                    <span className="truncate">{sessionLabel}</span>
                                    {s.pinned && (
                                      <Pin
                                        aria-hidden="true"
                                        data-testid={`sidebar-session-pinned-${s.key}`}
                                        className="h-3 w-3 shrink-0 text-muted-foreground"
                                      />
                                    )}
                                  </div>
                                </button>
                                {isBusy ? (
                                  <span
                                    role="status"
                                    data-testid={`sidebar-session-busy-${s.key}`}
                                    aria-label={t('chat:sessionList.aiReplying')}
                                    title={t('chat:sessionList.aiReplying')}
                                    className="shrink-0 pr-2 text-blue-700 group-hover:hidden group-focus-within:hidden dark:text-blue-400"
                                  >
                                    <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                                  </span>
                                ) : isUnread ? (
                                  <span
                                    role="status"
                                    data-testid={`sidebar-session-unread-${s.key}`}
                                    aria-label={t('chat:sessionList.unreadReply')}
                                    title={t('chat:sessionList.unreadReply')}
                                    className="shrink-0 pr-2 group-hover:hidden group-focus-within:hidden"
                                  >
                                    <span aria-hidden="true" className="block h-2 w-2 rounded-full bg-blue-500" />
                                  </span>
                                ) : relativeTime ? (
                                  <span
                                    data-testid={`sidebar-session-time-${s.key}`}
                                    title={new Date(activityMs).toLocaleString()}
                                    className="shrink-0 pr-2 text-2xs font-medium text-muted-foreground/55 group-hover:hidden group-focus-within:hidden"
                                  >
                                    {relativeTime}
                                  </span>
                                ) : null}
                                <div className="hidden items-center gap-0.5 pr-1.5 group-hover:flex group-focus-within:flex">
                                  <button
                                    aria-label={t('common:sidebar.renameSession')}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleStartRename(s.key, sessionLabel);
                                    }}
                                    className="flex items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
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
                                    className="flex items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })}

                      {hiddenCount > 0 && (
                        <button
                          type="button"
                          data-testid={getWorkspaceLoadMoreTestId(workspaceGroup.workspacePath)}
                          aria-label={t('chat:sessionList.loadMoreForWorkspace', {
                            count: loadMoreCount,
                            workspace: workspaceGroup.label,
                          })}
                          onClick={() => loadMoreWorkspaceSessions(workspaceGroup.workspacePath)}
                          className="ml-2 rounded-md px-2 py-1 text-tiny font-medium text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                        >
                          {t('chat:sessionList.loadMore')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {sessionNextCursor && (
              <button
                type="button"
                data-testid="sidebar-catalog-load-more"
                disabled={sessionCatalogLoading}
                onClick={() => void loadMoreSessions()}
                className="mt-2 w-full rounded-lg px-2 py-1.5 text-tiny font-medium text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground disabled:opacity-50 dark:hover:bg-white/10"
              >
                {sessionCatalogLoading ? t('common:status.loading') : t('common:sidebar.loadMoreConversations')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="mt-auto flex flex-col gap-1 p-2">
        <KernelStatusStrip collapsed={sidebarCollapsed} />

        <NavLink
          to="/settings"
          data-testid="sidebar-nav-settings"
          className={({ isActive }) =>
            cn(
              'sidebar-nav-text flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors',
              'hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80',
              isActive && 'bg-black/5 dark:bg-white/10 text-foreground',
              sidebarCollapsed ? 'justify-center px-0' : '',
            )
          }
        >
          <>
            <div className="flex shrink-0 items-center justify-center text-current [&_svg]:size-4">
              <SettingsIcon className="h-4 w-4" strokeWidth={2} />
            </div>
            {!sidebarCollapsed && (
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{t('sidebar.settings')}</span>
            )}
          </>
        </NavLink>

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
          className="fixed z-50 w-44 rounded-lg border border-border/70 bg-surface-modal p-1 text-meta text-foreground shadow-xl shadow-black/10 dark:shadow-black/35"
          style={{ left: contextMenuLeft, top: contextMenuTop }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            role="menuitem"
            data-testid={`sidebar-session-context-pin-${sessionContextMenu.key}`}
            onClick={() => void handleContextMenuPinToggle()}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground/85 transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
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
            onClick={() => handleStartRename(sessionContextMenu.key, sessionContextMenu.label)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground/85 transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
          >
            <Pencil className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t('common:sidebar.renameSession')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid={`sidebar-session-context-export-${sessionContextMenu.key}`}
            onClick={() => void handleContextMenuExport()}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground/85 transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
          >
            <Download className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t('common:sidebar.exportSession')}</span>
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
            <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-surface-input px-2.5">
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
            <div className="mt-2 grid grid-cols-2 gap-2" data-testid="sidebar-session-search-filters">
              <select
                data-testid="sidebar-session-filter-kernel"
                aria-label={t('common:sidebar.filterKernel')}
                value={sessionKernelFilter}
                onChange={event => setSessionKernelFilter(event.target.value)}
                className="h-8 rounded-lg border border-border/70 bg-surface-input px-2 text-xs text-foreground"
              >
                <option value="">{t('common:sidebar.allKernels')}</option>
                {kernelOptions.map(option => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
              <select
                data-testid="sidebar-session-filter-kernel-scope"
                aria-label={t('common:sidebar.filterKernelScope')}
                value={sessionKernelScope}
                onChange={event => setSessionKernelScope(event.target.value as 'last' | 'participated')}
                disabled={!sessionKernelFilter}
                className="h-8 rounded-lg border border-border/70 bg-surface-input px-2 text-xs text-foreground disabled:opacity-50"
              >
                <option value="last">{t('common:sidebar.lastKernelFilter')}</option>
                <option value="participated">{t('common:sidebar.participatedKernelFilter')}</option>
              </select>
              <select
                data-testid="sidebar-session-filter-agent"
                aria-label={t('common:sidebar.filterAgent')}
                value={sessionAgentFilter}
                onChange={event => setSessionAgentFilter(event.target.value)}
                className="h-8 rounded-lg border border-border/70 bg-surface-input px-2 text-xs text-foreground"
              >
                <option value="">{t('common:sidebar.allAgents')}</option>
                {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
              <select
                data-testid="sidebar-session-filter-source"
                aria-label={t('common:sidebar.filterSource')}
                value={sessionSourceFilter}
                onChange={event => setSessionSourceFilter(event.target.value)}
                className="h-8 rounded-lg border border-border/70 bg-surface-input px-2 text-xs text-foreground"
              >
                <option value="">{t('common:sidebar.allSources')}</option>
                {[...new Set(sessions.map(session => session.sourceChannel).filter((value): value is string => !!value))]
                  .map(source => (
                    <option key={source} value={source}>{CHANNEL_NAMES[source as keyof typeof CHANNEL_NAMES] ?? source}</option>
                  ))}
              </select>
              <select
                data-testid="sidebar-session-filter-workspace"
                aria-label={t('common:sidebar.filterWorkspace')}
                value={sessionWorkspaceFilter}
                onChange={event => setSessionWorkspaceFilter(event.target.value)}
                className="h-8 rounded-lg border border-border/70 bg-surface-input px-2 text-xs text-foreground"
              >
                <option value="">{t('common:sidebar.allWorkspaces')}</option>
                {workspaceSessionGroups.map(group => (
                  <option key={group.workspacePath} value={group.workspacePath}>{group.label}</option>
                ))}
              </select>
              <select
                data-testid="sidebar-session-filter-attention"
                aria-label={t('common:sidebar.filterAttention')}
                value={sessionAttentionFilter}
                onChange={event => setSessionAttentionFilter(event.target.value as 'all' | 'busy' | 'unread')}
                className="h-8 rounded-lg border border-border/70 bg-surface-input px-2 text-xs text-foreground"
              >
                <option value="all">{t('common:sidebar.allAttention')}</option>
                <option value="busy">{t('common:sidebar.busyConversations')}</option>
                <option value="unread">{t('common:sidebar.unreadConversations')}</option>
              </select>
            </div>
          </div>
          <div data-testid="sidebar-session-search-results" className="max-h-80 overflow-y-auto p-1.5">
            {sessionSearchLoading ? (
              <div className="flex items-center justify-center px-3 py-6 text-meta text-muted-foreground">
                <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                {t('common:status.loading')}
              </div>
            ) : sessionSearchResults.length > 0 ? (
              sessionSearchResults.map((session) => (
                <button
                  key={session.key}
                  type="button"
                  data-testid={`sidebar-session-search-result-${session.key}`}
                  onClick={() => openSearchResult(session.key)}
                  className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-black/5 focus-visible:bg-black/5 focus-visible:outline-none dark:hover:bg-white/10 dark:focus-visible:bg-white/10"
                >
                  <span className="shrink-0 rounded-full bg-surface-input px-2 py-0.5 text-2xs font-medium text-muted-foreground">
                    {session.agentName}
                  </span>
                  {session.kernelId && (
                    <span className="shrink-0 rounded-full bg-violet-500/10 px-2 py-0.5 text-2xs font-medium text-violet-700 dark:text-violet-400">
                      {kernelDisplayName(session.kernelId)}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground/85">{session.label}</span>
                    <span className="block truncate text-2xs text-muted-foreground">
                      {[session.workspaceLabel, session.channelName].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {session.pinned && <Pin aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
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
          const result = await deleteSession(targetSession.key);
          if (!result.success) return;
          if (currentSessionKey === targetSession.key) navigate('/');
          setDeleteDialogOpen(false);
        }}
        onCancel={() => setDeleteDialogOpen(false)}
      />
      <ConfirmDialog
        open={batchDeleteDialogOpen}
        title={t('common:sidebar.deleteSelectedSessions')}
        message={t('common:sidebar.deleteSelectedSessionsConfirm', { count: selectedSessionCount })}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={handleBatchDeleteConfirm}
        onCancel={() => setBatchDeleteDialogOpen(false)}
      />
      <ConfirmDialog
        open={workspaceDeleteDialogOpen}
        title={t('chat:sessionList.deleteWorkspaceTitle')}
        message={t('chat:sessionList.deleteWorkspaceConfirm', {
          workspace: workspaceToDelete?.label ?? '',
          count: workspaceToDelete?.sessionKeys.length ?? 0,
        })}
        confirmLabel={t('chat:sessionList.deleteWorkspaceConfirmAction')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={async () => {
          const target = workspaceToDelete;
          if (!target) return;
          const currentWasTargeted = target.sessionKeys.includes(currentSessionKey);
          const result = await deleteSessions(target.sessionKeys);
          if (result.failedKeys.length === 0) {
            try {
              await removeWorkspace(target.path);
            } catch {
              toast.error(t('chat:sessionList.deleteWorkspaceCleanupFailed'));
            }
          } else {
            toast.error(t('chat:sessionList.deleteWorkspacePartialFailure', {
              count: result.failedKeys.length,
            }));
          }
          if (currentWasTargeted && result.deletedKeys.includes(currentSessionKey)) navigate('/');
          setWorkspaceDeleteDialogOpen(false);
        }}
        onCancel={() => setWorkspaceDeleteDialogOpen(false)}
      />
    </aside>
  );
}
