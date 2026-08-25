/**
 * Chat Toolbar
 * Session selector, question directory, and the workspace browser
 * entry point.  Rendered in the Header when on the Chat page.
 */
import { useMemo } from 'react';
import { Bot, FolderTree, ListTree } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useAgentsStore } from '@/stores/agents';
import { useArtifactPanel } from '@/stores/artifact-panel';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { WORKSPACE_BROWSER_ENABLED } from '@/components/file-preview/workspace-browser-config';
import type { KernelId } from '@shared/kernels/contracts';
import { kernelDisplayName, useKernelStore } from '@/stores/kernels';

export type ChatToolbarProps = {
  questionDirectoryOpen?: boolean;
  questionDirectoryCount?: number;
  onToggleQuestionDirectory?: () => void;
  workspaceAvailable?: boolean;
  selectedKernelId?: KernelId;
  onSelectKernel?: (kernelId: KernelId) => void;
  kernelSelectionDisabled?: boolean;
};

export function ChatToolbar({
  questionDirectoryOpen = false,
  questionDirectoryCount = 0,
  onToggleQuestionDirectory,
  workspaceAvailable = false,
  selectedKernelId,
  onSelectKernel,
  kernelSelectionDisabled = false,
}: ChatToolbarProps = {}) {
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const agents = useAgentsStore((s) => s.agents);
  const openBrowser = useArtifactPanel((s) => s.openBrowser);
  const panelOpen = useArtifactPanel((s) => s.open);
  const panelTab = useArtifactPanel((s) => s.tab);
  const closePanel = useArtifactPanel((s) => s.close);
  const { t } = useTranslation('chat');
  const catalog = useKernelStore(state => state.catalog);
  const runtimes = useKernelStore(state => state.runtimes);
  const selectableKernels = (catalog?.entries ?? []).filter(entry => (
    entry.installation.state === 'installed' || runtimes[entry.kernelId]?.state !== 'not-installed'
  ));
  const currentAgent = useMemo(
    () => (agents ?? []).find((agent) => agent.id === currentAgentId) ?? null,
    [agents, currentAgentId],
  );
  const currentAgentName = currentAgent?.name ?? currentAgentId;

  const browserActive = WORKSPACE_BROWSER_ENABLED && panelOpen && panelTab === 'browser';
  const questionDirectoryAvailable = questionDirectoryCount > 1 && !!onToggleQuestionDirectory;

  return (
    <div className="flex items-center gap-2">
      <label className="no-drag flex items-center gap-1.5 rounded-full border border-black/10 bg-white/70 px-2 py-1 text-xs font-medium text-foreground/80 dark:border-white/10 dark:bg-white/5">
        <span className="sr-only">{t('kernelSelector.label')}</span>
        <span aria-hidden="true" className={cn(
          'h-2 w-2 rounded-full',
          selectedKernelId && runtimes[selectedKernelId]?.state === 'ready'
            ? 'bg-green-600 dark:bg-green-400'
            : 'bg-muted-foreground/40',
        )} />
        <select
          data-testid="chat-kernel-selector"
          aria-label={t('kernelSelector.label')}
          value={selectedKernelId ?? ''}
          disabled={kernelSelectionDisabled || selectableKernels.length === 0}
          onChange={event => onSelectKernel?.(event.target.value as KernelId)}
          className="max-w-40 cursor-pointer appearance-none bg-transparent pr-1 text-xs outline-none disabled:cursor-not-allowed"
        >
          {selectableKernels.length === 0 && <option value="">{t('kernelSelector.noneInstalled')}</option>}
          {selectableKernels.map(entry => (
            <option key={entry.kernelId} value={entry.kernelId}>{kernelDisplayName(entry.kernelId)}</option>
          ))}
        </select>
      </label>
      <div className="hidden sm:flex items-center gap-1.5 rounded-full border border-black/10 bg-white/70 px-3 py-1.5 text-xs font-medium text-foreground/80 dark:border-white/10 dark:bg-white/5">
        <Bot className="h-3.5 w-3.5 text-primary" />
        <span>{t('toolbar.currentAgent', { agent: currentAgentName })}</span>
      </div>
      {WORKSPACE_BROWSER_ENABLED && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              data-testid="chat-toolbar-workspace"
              variant="ghost"
              size="icon"
              className={cn(
                'h-8 w-8 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10',
                browserActive && 'bg-foreground/10 text-foreground',
              )}
              onClick={() => (browserActive ? closePanel() : openBrowser())}
              disabled={!workspaceAvailable}
              aria-label={t('toolbar.workspace')}
            >
              <FolderTree className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('toolbar.workspace')}</p>
          </TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            data-testid="chat-question-directory-toggle"
            variant="ghost"
            size="icon"
            className={cn(
              'h-8 w-8 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10',
              questionDirectoryOpen && 'bg-foreground/10 text-foreground',
            )}
            onClick={onToggleQuestionDirectory}
            disabled={!questionDirectoryAvailable}
            aria-label={t('questionDirectory.title')}
            aria-controls="chat-question-directory"
            aria-expanded={questionDirectoryOpen}
          >
            <ListTree className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('questionDirectory.title')}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
