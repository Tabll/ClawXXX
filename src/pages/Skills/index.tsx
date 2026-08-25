/**
 * Skills Page
 * Browse and manage AI skills
 */
import { Suspense, lazy, useEffect, useState, useCallback, useMemo } from 'react';
import { Search, Puzzle, Lock, Package, X, AlertCircle, Trash2, FolderOpen, Copy, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useSkillsStore } from '@/stores/skills';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/lib/utils';
import { hostApi } from '@/lib/host-api';
import { toast } from 'sonner';
import type { Skill } from '@/types/skill';
import type { SkillMutationResult, SkillMutationTarget } from '@shared/domains/skills';
import type { KernelId } from '@shared/kernels/contracts';
import { rendererExtensionRegistry } from '@/extensions/registry';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { SkillFileSections } from '@/components/file-preview/SkillFileSections';
import type { FilePreviewTarget } from '@/components/file-preview/FilePreviewOverlay';
import type { SkillFile } from '@/lib/skill-files';
import { kernelDisplayName, kernelOptionsFor, useKernelStore } from '@/stores/kernels';

const FilePreviewOverlayLazy = lazy(() =>
  import('@/components/file-preview/FilePreviewOverlay').then((m) => ({ default: m.FilePreviewOverlay })),
);

function skillFileToTarget(file: SkillFile): FilePreviewTarget {
  return {
    filePath: file.filePath,
    fileName: file.fileName,
    ext: file.ext,
    mimeType: file.mimeType,
    contentType: file.contentType,
  };
}

const INSTALL_ERROR_CODES = new Set(['installTimeoutError', 'installRateLimitError']);
const FETCH_ERROR_CODES = new Set(['fetchTimeoutError', 'fetchRateLimitError', 'timeoutError', 'rateLimitError']);
const SEARCH_ERROR_CODES = new Set(['searchTimeoutError', 'searchRateLimitError', 'timeoutError', 'rateLimitError']);

type SkillKernelOption = { id: KernelId; label: string };

function enabledForTarget(skill: Skill, target: SkillMutationTarget): boolean {
  if (!skill.enabledForKernels || !skill.installedForKernels) return skill.enabled;
  const kernels = target === 'all-installed' ? skill.installedForKernels : [target];
  return kernels.length > 0 && kernels.every(kernelId => skill.enabledForKernels!.includes(kernelId));
}

function mutationHasFailures(result: SkillMutationResult | SkillMutationResult[] | undefined): boolean {
  if (!result) return false;
  const mutations = Array.isArray(result) ? result : [result];
  return mutations.some(mutation => mutation.results.some(kernel => !kernel.ok));
}

// Skill detail dialog component
interface SkillDetailDialogProps {
  skill: Skill | null;
  isOpen: boolean;
  onClose: () => void;
  onToggle: (enabled: boolean) => void;
  onUninstall?: (slug: string) => void;
  onOpenFolder?: (skill: Skill) => Promise<void> | void;
  onRetry?: (skillId: string, kernelId: KernelId) => Promise<void> | void;
  kernelOptions: SkillKernelOption[];
}

function resolveSkillSourceLabel(skill: Skill, t: TFunction<'skills'>): string {
  const source = (skill.source || '').trim().toLowerCase();
  if (!source) {
    if (skill.isBundled) return t('source.badge.bundled', { defaultValue: 'Bundled dir' });
    return t('source.badge.unknown', { defaultValue: 'Unknown source' });
  }
  if (source === 'openclaw-bundled') return t('source.badge.bundled', { defaultValue: 'Bundled dir' });
  if (source === 'openclaw-managed') return t('source.badge.managed', { defaultValue: 'Managed' });
  if (source === 'openclaw-workspace') return t('source.badge.workspace', { defaultValue: 'Workspace' });
  if (source === 'openclaw-extra') return t('source.badge.extra', { defaultValue: 'Extra dirs' });
  if (source === 'openclaw-plugin') return t('source.badge.plugin', { defaultValue: 'Plugin dir' });
  if (source === 'agents-skills-personal')
    return t('source.badge.agentsPersonal', { defaultValue: 'Personal .agents' });
  if (source === 'agents-skills-project') return t('source.badge.agentsProject', { defaultValue: 'Project .agents' });
  if (source === 'canonical-bundled') return t('source.badge.canonicalBundled');
  if (source === 'canonical-marketplace') return t('source.badge.canonicalMarketplace');
  if (source === 'canonical-local') return t('source.badge.canonicalLocal');
  return source;
}

function canUninstallSkill(skill: Skill): boolean {
  const source = (skill.source || '').trim().toLowerCase();
  return source === 'openclaw-managed' || source === 'canonical-marketplace';
}

function SkillDetailDialog({ skill, isOpen, onClose, onToggle, onUninstall, onOpenFolder, onRetry, kernelOptions }: SkillDetailDialogProps) {
  const { t } = useTranslation('skills');
  const [openedSkillFile, setOpenedSkillFile] = useState<FilePreviewTarget | null>(null);
  const detailMetaComponents = rendererExtensionRegistry.getSkillDetailMetaComponents();

  const handleCopyPath = async () => {
    if (!skill?.baseDir) return;
    try {
      await navigator.clipboard.writeText(skill.baseDir);
      toast.success(t('toast.copiedPath'));
    } catch (err) {
      toast.error(t('toast.failedCopyPath') + ': ' + String(err));
    }
  };

  if (!skill) return null;

  const uninstallable = canUninstallSkill(skill);

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Suspense fallback={null}>
        <FilePreviewOverlayLazy file={openedSkillFile} readOnly onClose={() => setOpenedSkillFile(null)} />
      </Suspense>
      <SheetContent
        className="w-full sm:max-w-[450px] p-0 flex flex-col border-l border-black/10 dark:border-white/10 bg-surface-modal shadow-[0_0_40px_rgba(0,0,0,0.2)]"
        side="right"
      >
        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-8 py-10">
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 flex items-center justify-center rounded-full bg-surface-modal border border-black/5 dark:border-white/5 shrink-0 mb-4 relative shadow-sm">
              <span className="text-3xl">{skill.icon || '🔧'}</span>
              {skill.isCore && (
                <div className="absolute -bottom-1 -right-1 bg-surface-modal rounded-full p-1 shadow-sm border border-black/5 dark:border-white/5">
                  <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
                </div>
              )}
            </div>
            <h2 className="text-3xl font-serif text-foreground font-normal mb-3 text-center tracking-tight">
              {skill.name}
            </h2>
            <div
              data-skill-detail-meta-row="1"
              className="flex items-center justify-center flex-wrap gap-2.5 mb-6 opacity-80"
            >
              {skill.version && (
                <Badge
                  variant="secondary"
                  className="shrink-0 whitespace-nowrap font-mono text-tiny font-medium px-3 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] border-0 shadow-none text-foreground/70 transition-colors"
                >
                  v{skill.version}
                </Badge>
              )}
              <Badge
                variant="secondary"
                className="shrink-0 whitespace-nowrap font-mono text-tiny font-medium px-3 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] border-0 shadow-none text-foreground/70 transition-colors"
              >
                {skill.isCore
                  ? t('detail.coreSystem')
                  : skill.isBundled
                    ? t('detail.bundled')
                    : t('detail.userInstalled')}
              </Badge>
              {detailMetaComponents.map((DetailMetaComponent, index) => (
                <DetailMetaComponent key={`skill-detail-meta-${index}`} skill={skill} />
              ))}
            </div>

            {skill.description && (
              <p className="text-sm text-foreground/70 font-medium leading-[1.6] text-center px-4">
                {skill.description}
              </p>
            )}
          </div>

          <div className="space-y-7 px-1">
            {skill.installedForKernels && (
              <div className="space-y-3" data-testid="skill-kernel-status-list">
                <h3 className="text-meta font-bold text-foreground/80">{t('kernel.title')}</h3>
                {kernelOptions.map(({ id: kernelId, label }) => {
                  const installed = skill.installedForKernels?.includes(kernelId) ?? false;
                  const enabled = skill.enabledForKernels?.includes(kernelId) ?? false;
                  const compatibility = skill.compatibility?.find(entry => entry.kernelId === kernelId);
                  const projection = skill.projections?.find(entry => entry.kernelId === kernelId);
                  const state = !compatibility?.compatible
                    ? 'unsupported'
                    : projection?.state ?? (installed ? 'pending' : 'notInstalled');
                  return (
                    <div
                      key={kernelId}
                      data-testid={`skill-kernel-status-${kernelId}`}
                      className="rounded-xl border border-black/10 dark:border-white/10 p-3 bg-black/[0.02] dark:bg-white/[0.03]"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold">{label}</span>
                            <Badge variant="outline" className="font-mono text-2xs rounded-full">
                              {t(`kernel.state.${state}`)}
                            </Badge>
                            {installed && (
                              <Badge variant="secondary" className="font-mono text-2xs rounded-full border-0">
                                {enabled ? t('kernel.enabled') : t('kernel.disabled')}
                              </Badge>
                            )}
                          </div>
                          {(projection?.error?.message || compatibility?.reason) && (
                            <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                              {projection?.error?.message || compatibility?.reason}
                            </p>
                          )}
                        </div>
                        {onRetry && installed && (projection?.state === 'failed' || projection?.state === 'partial' || projection?.state === 'pending') && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid={`skill-retry-${kernelId}`}
                            onClick={() => onRetry(skill.id, kernelId)}
                            className="h-8 shrink-0"
                          >
                            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                            {t('kernel.retry')}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="space-y-2">
              <h3 className="text-meta font-bold text-foreground/80">{t('detail.source')}</h3>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge
                  variant="secondary"
                  className="shrink-0 whitespace-nowrap font-mono text-tiny font-medium px-3 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] border-0 shadow-none text-foreground/70"
                >
                  {resolveSkillSourceLabel(skill, t)}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={skill.baseDir || t('detail.pathUnavailable')}
                  readOnly
                  className="h-[38px] font-mono text-xs bg-transparent border-black/10 dark:border-white/10 rounded-xl text-foreground/70"
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="h-[38px] w-[38px] border-black/10 dark:border-white/10"
                  disabled={!skill.baseDir}
                  onClick={handleCopyPath}
                  title={t('detail.copyPath')}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-[38px] w-[38px] border-black/10 dark:border-white/10"
                  disabled={!skill.baseDir}
                  onClick={() => onOpenFolder?.(skill)}
                  title={t('detail.openActualFolder')}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* File Sections — read-only preview of skill content */}
            {skill.baseDir && (
              <div className="space-y-3">
                <h3 className="text-meta font-bold text-foreground/80">
                  {t('detail.sections.title', { defaultValue: '内容' })}
                </h3>
                <SkillFileSections
                  baseDir={skill.baseDir}
                  onOpen={(file) => setOpenedSkillFile(skillFileToTarget(file))}
                />
              </div>
            )}
          </div>

          {/* Centered Footer Button — uninstall / disable / enable */}
          {!skill.isCore && (
            <div className="pt-8 pb-4 flex items-center justify-center w-full px-2 max-w-[340px] mx-auto">
              <Button
                variant="outline"
                className="w-full h-[42px] text-meta rounded-full font-semibold shadow-sm bg-transparent border-black/20 dark:border-white/20 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-foreground/80 hover:text-foreground"
                onClick={() => {
                  if (uninstallable && onUninstall && skill.slug) {
                    onUninstall(skill.slug);
                    onClose();
                  } else {
                    onToggle(!skill.enabled);
                  }
                }}
              >
                {uninstallable && onUninstall
                  ? t('detail.uninstall')
                  : skill.enabled
                    ? t('detail.disable')
                    : t('detail.enable')}
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function Skills() {
  const {
    skills,
    loading,
    error,
    fetchSkills,
    enableSkill,
    disableSkill,
    searchResults,
    searchSkills,
    installSkill,
    uninstallSkill,
    searching,
    searchError,
    installing,
    retryProjection,
  } = useSkillsStore();
  const { t } = useTranslation('skills');
  const [searchQuery, setSearchQuery] = useState('');
  const [installQuery, setInstallQuery] = useState('');
  const [installSheetOpen, setInstallSheetOpen] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [operationTarget, setOperationTarget] = useState<SkillMutationTarget>('all-installed');
  const [marketplaceAvailable, setMarketplaceAvailable] = useState(false);
  const kernelCatalog = useKernelStore((state) => state.catalog);
  const kernelOptions = useMemo<SkillKernelOption[]>(() => kernelOptionsFor(
    kernelCatalog,
    skills.flatMap(skill => [
      ...(skill.installedForKernels ?? []),
      ...(skill.compatibility ?? []).map(entry => entry.kernelId),
      ...(skill.projections ?? []).map(entry => entry.kernelId),
    ]),
  ), [kernelCatalog, skills]);
  const skillTargets = useMemo<SkillMutationTarget[]>(
    () => [...kernelOptions.map(option => option.id), 'all-installed'],
    [kernelOptions],
  );
  const targetLabel = useCallback((target: SkillMutationTarget) => (
    target === 'all-installed'
      ? t('kernel.target.all-installed')
      : kernelOptions.find(option => option.id === target)?.label ?? kernelDisplayName(target)
  ), [kernelOptions, t]);

  useEffect(() => {
    void fetchSkills().then(() => undefined);
  }, [fetchSkills]);

  useEffect(() => {
    let cancelled = false;
    void hostApi.skills
      .clawhubCapability()
      .then((result) => {
        if (cancelled) return;
        setMarketplaceAvailable(
          Boolean(result.success && (result.capability?.canInstall || result.capability?.canSearch)),
        );
      })
      .catch(() => {
        if (!cancelled) setMarketplaceAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const safeSkills = useMemo(() => (Array.isArray(skills) ? skills : []), [skills]);
  const enabledSkillsCount = safeSkills.filter((skill) => skill.enabled).length;
  const disabledSkillsCount = safeSkills.filter((skill) => !skill.enabled).length;
  const filteredSkills = safeSkills
    .filter((skill) => {
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        q.length === 0 ||
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.id.toLowerCase().includes(q) ||
        (skill.slug || '').toLowerCase().includes(q) ||
        (skill.author || '').toLowerCase().includes(q);
      const matchesStatus = statusFilter === 'all' || (statusFilter === 'enabled' ? skill.enabled : !skill.enabled);
      return matchesSearch && matchesStatus;
    })
    .sort((a, b) => {
      if (a.enabled && !b.enabled) return -1;
      if (!a.enabled && b.enabled) return 1;
      if (a.isCore && !b.isCore) return -1;
      if (!a.isCore && b.isCore) return 1;
      return a.name.localeCompare(b.name);
    });

  const handleToggle = useCallback(
    async (skillId: string, enable: boolean) => {
      try {
        if (enable) {
          const result = await enableSkill(skillId, operationTarget);
          toast[mutationHasFailures(result) ? 'warning' : 'success'](
            mutationHasFailures(result) ? t('toast.kernelPartial') : t('toast.enabled'),
          );
        } else {
          const result = await disableSkill(skillId, operationTarget);
          toast[mutationHasFailures(result) ? 'warning' : 'success'](
            mutationHasFailures(result) ? t('toast.kernelPartial') : t('toast.disabled'),
          );
        }
      } catch (err) {
        toast.error(String(err));
      }
    },
    [enableSkill, disableSkill, operationTarget, t],
  );

  useEffect(() => {
    if (!selectedSkill) return;
    const refreshed = safeSkills.find(skill => skill.id === selectedSkill.id);
    if (refreshed && refreshed !== selectedSkill) setSelectedSkill(refreshed);
  }, [safeSkills, selectedSkill]);

  const handleStatusFilterClick = useCallback((nextFilter: 'enabled' | 'disabled') => {
    setStatusFilter((current) => (current === nextFilter ? 'all' : nextFilter));
  }, []);

  const handleOpenSkillFolder = useCallback(
    async (skill: Skill) => {
      try {
        const result = await hostApi.skills.clawhubOpenSkillPath({
          skillKey: skill.id,
          slug: skill.slug,
          baseDir: skill.baseDir,
        });
        if (!result.success) {
          throw new Error(result.error || 'Failed to open folder');
        }
      } catch (err) {
        toast.error(t('toast.failedOpenActualFolder') + ': ' + String(err));
      }
    },
    [t],
  );

  const skillsDirPath = '~/.clawx/skills';

  useEffect(() => {
    if (!installSheetOpen) {
      return;
    }

    const query = installQuery.trim();
    if (query.length === 0) {
      searchSkills('');
      return;
    }

    const timer = setTimeout(() => {
      searchSkills(query);
    }, 300);
    return () => clearTimeout(timer);
  }, [installQuery, installSheetOpen, searchSkills]);

  const handleInstall = useCallback(
    async (slug: string) => {
      try {
        const result = await installSkill(slug, undefined, operationTarget);
        toast[mutationHasFailures(result) ? 'warning' : 'success'](
          mutationHasFailures(result) ? t('toast.kernelPartial') : t('toast.installed'),
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (INSTALL_ERROR_CODES.has(errorMessage)) {
          toast.error(t(`toast.${errorMessage}`, { path: skillsDirPath }), { duration: 10000 });
        } else {
          toast.error(t('toast.failedInstall') + ': ' + errorMessage);
        }
      }
    },
    [installSkill, operationTarget, t, skillsDirPath],
  );
  const handleUninstall = useCallback(
    async (slug: string) => {
      try {
        const result = await uninstallSkill(slug, operationTarget);
        toast[mutationHasFailures(result) ? 'warning' : 'success'](
          mutationHasFailures(result) ? t('toast.kernelPartial') : t('toast.uninstalled'),
        );
      } catch (err) {
        toast.error(t('toast.failedUninstall') + ': ' + String(err));
      }
    },
    [uninstallSkill, operationTarget, t],
  );

  if (loading) {
    return (
      <div className="flex flex-col -m-6 dark:bg-background min-h-[calc(100vh-2.5rem)] items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div
      data-testid="skills-page"
      className="flex flex-col -m-6 dark:bg-background h-[calc(100vh-2.5rem)] overflow-hidden"
    >
      <div className="w-full max-w-5xl mx-auto flex flex-col h-full p-10 pt-16 pb-0">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-start justify-between mb-6 shrink-0 gap-4">
          <div>
            <h1 className="text-5xl md:text-6xl font-serif text-foreground mb-3 font-normal tracking-tight">
              {t('title')}
            </h1>
            <p className="text-subtitle text-foreground/70 font-medium">{t('subtitle')}</p>
          </div>

          <div className="flex items-center gap-3 md:mt-2">
          </div>
        </div>

        {/* Sub Navigation and Actions */}
        <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-black/10 dark:border-white/10 pb-4 mb-4 shrink-0 gap-4">
          <div className="flex items-center flex-wrap gap-2 text-sm">
            <div className="relative group flex items-center bg-black/5 dark:bg-white/5 rounded-full px-3 py-1.5 focus-within:bg-black/10 transition-colors border border-transparent focus-within:border-black/10 dark:focus-within:border-white/10 mr-2">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                placeholder={t('search')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="ml-2 bg-transparent outline-none w-28 md:w-40 font-normal placeholder:text-foreground/50 text-meta text-foreground"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="text-foreground/50 hover:text-foreground shrink-0 ml-1"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="skills-filter-enabled"
              onClick={() => handleStatusFilterClick('enabled')}
              className={cn(
                'h-8 rounded-full px-3 text-meta font-medium border shadow-none',
                statusFilter === 'enabled'
                  ? 'bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/10 text-foreground'
                  : 'bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5',
              )}
            >
              {t('filter.enabledList', { count: enabledSkillsCount })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="skills-filter-disabled"
              onClick={() => handleStatusFilterClick('disabled')}
              className={cn(
                'h-8 rounded-full px-3 text-meta font-medium border shadow-none',
                statusFilter === 'disabled'
                  ? 'bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/10 text-foreground'
                  : 'bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5',
              )}
            >
              {t('filter.disabledList', { count: disabledSkillsCount })}
            </Button>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div
              data-testid="skills-target-scope"
              className="flex items-center rounded-lg border border-black/10 dark:border-white/10 p-0.5"
              aria-label={t('kernel.targetLabel')}
            >
              {skillTargets.map((target) => (
                <Button
                  key={target}
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid={`skills-target-${target}`}
                  onClick={() => setOperationTarget(target)}
                  className={cn(
                    'h-7 rounded-md px-2.5 text-2xs font-medium shadow-none',
                    operationTarget === target
                      ? 'bg-black/5 dark:bg-white/10 text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {targetLabel(target)}
                </Button>
              ))}
            </div>
            {marketplaceAvailable && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setInstallQuery('');
                  setInstallSheetOpen(true);
                }}
                className="h-8 text-meta font-medium rounded-md px-3 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none"
              >
                {t('actions.installSkill')}
              </Button>
            )}
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto pr-2 pb-10 min-h-0 -mr-2">
          {error && (
            <div className="mb-4 p-4 rounded-xl border border-destructive/50 bg-destructive/10 text-destructive text-sm font-medium flex items-center gap-2">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <span>{FETCH_ERROR_CODES.has(error) ? t(`toast.${error}`, { path: skillsDirPath }) : error}</span>
            </div>
          )}

          <div className="flex flex-col gap-1">
            {filteredSkills.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <Puzzle className="h-10 w-10 mb-4 opacity-50" />
                <p>{searchQuery ? t('noSkillsSearch') : t('noSkillsAvailable')}</p>
              </div>
            ) : (
              filteredSkills.map((skill) => (
                <div
                  key={skill.id}
                  data-testid={`skill-row-${skill.id}`}
                  className="group flex flex-row items-center justify-between py-3.5 px-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer border-b border-black/5 dark:border-white/5 last:border-0"
                  onClick={() => setSelectedSkill(skill)}
                >
                  <div className="flex items-start gap-4 flex-1 overflow-hidden pr-4">
                    <div className="h-10 w-10 shrink-0 flex items-center justify-center text-2xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-xl overflow-hidden">
                      {skill.icon || '🧩'}
                    </div>
                    <div className="flex flex-col overflow-hidden">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-semibold text-foreground truncate">{skill.name}</h3>
                        {skill.isCore ? <Lock className="h-3 w-3 text-muted-foreground" /> : null}
                      </div>
                      <p className="text-sm text-muted-foreground line-clamp-1 pr-6 leading-relaxed">
                        {skill.description}
                      </p>
                      <div className="mt-1 flex items-center gap-2 text-tiny text-foreground/55 min-w-0">
                        <Badge
                          variant="secondary"
                          className="shrink-0 whitespace-nowrap px-1.5 py-0 h-5 text-2xs font-medium bg-black/5 dark:bg-white/10 border-0 shadow-none"
                        >
                          {resolveSkillSourceLabel(skill, t)}
                        </Badge>
                        <span className="truncate font-mono min-w-0">
                          {skill.baseDir || t('detail.pathUnavailable')}
                        </span>
                      </div>
                      {skill.installedForKernels && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {kernelOptions.map(({ id: kernelId, label }) => {
                            const compatibility = skill.compatibility?.find(entry => entry.kernelId === kernelId);
                            const projection = skill.projections?.find(entry => entry.kernelId === kernelId);
                            const installed = skill.installedForKernels?.includes(kernelId);
                            const state = !compatibility?.compatible
                              ? 'unsupported'
                              : projection?.state ?? (installed ? 'pending' : 'notInstalled');
                            return (
                              <Badge
                                key={kernelId}
                                variant="outline"
                                data-testid={`skill-projection-${skill.id}-${kernelId}`}
                                title={projection?.error?.message || compatibility?.reason}
                                className={cn(
                                  'font-mono text-2xs rounded-full border-black/10 dark:border-white/10',
                                  state === 'ready' && 'text-green-700 dark:text-green-400',
                                  (state === 'failed' || state === 'unsupported') && 'text-red-700 dark:text-red-400',
                                  (state === 'pending' || state === 'applying' || state === 'partial')
                                    && 'text-amber-700 dark:text-amber-400',
                                )}
                              >
                                {label} · {t(`kernel.state.${state}`)}
                              </Badge>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-6 shrink-0" onClick={(e) => e.stopPropagation()}>
                    {skill.version && (
                      <span className="text-meta font-mono text-muted-foreground">v{skill.version}</span>
                    )}
                    <Switch
                      data-testid={`skill-toggle-${skill.id}`}
                      checked={enabledForTarget(skill, operationTarget)}
                      onCheckedChange={(checked) => handleToggle(skill.id, checked)}
                      disabled={skill.isCore}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <Sheet open={installSheetOpen && marketplaceAvailable} onOpenChange={setInstallSheetOpen}>
        <SheetContent
          className="w-full sm:max-w-[560px] p-0 flex flex-col border-l border-black/10 dark:border-white/10 bg-surface-modal shadow-[0_0_40px_rgba(0,0,0,0.2)]"
          side="right"
        >
          <div className="px-7 py-6 border-b border-black/10 dark:border-white/10">
            <h2 className="text-2xl font-serif text-foreground font-normal tracking-tight">
              {t('marketplace.installDialogTitle')}
            </h2>
            <p className="mt-1 text-meta text-foreground/70">{t('marketplace.installDialogSubtitle')}</p>
            <div className="mt-3 flex items-center gap-2" data-testid="skills-install-target-scope">
              <span className="text-xs font-semibold text-foreground/70">{t('kernel.installTarget')}</span>
              {skillTargets.map((target) => (
                <Button
                  key={target}
                  type="button"
                  variant={operationTarget === target ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={() => setOperationTarget(target)}
                  className="h-7 text-2xs"
                >
                  {targetLabel(target)}
                </Button>
              ))}
            </div>
            <div className="mt-4 flex flex-col md:flex-row gap-2">
              <div className="relative flex items-center bg-black/5 dark:bg-white/5 rounded-xl px-3 py-2 border border-black/10 dark:border-white/10 flex-1">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Input
                  placeholder={t('searchMarketplace')}
                  value={installQuery}
                  onChange={(e) => setInstallQuery(e.target.value)}
                  className="ml-2 h-auto border-0 bg-transparent p-0 shadow-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 text-meta"
                />
                {installQuery && (
                  <button
                    type="button"
                    onClick={() => setInstallQuery('')}
                    className="text-foreground/50 hover:text-foreground shrink-0 ml-1"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <Button
                variant="outline"
                disabled
                className="h-10 rounded-xl border-black/10 dark:border-white/10 bg-transparent text-muted-foreground"
              >
                {t('marketplace.sourceLabel')}: {t('marketplace.sourceClawHub')}
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {searchError && (
              <div className="mb-4 p-4 rounded-xl border border-destructive/50 bg-destructive/10 text-destructive text-sm font-medium flex items-center gap-2">
                <AlertCircle className="h-5 w-5 shrink-0" />
                <span>
                  {SEARCH_ERROR_CODES.has(searchError.replace('Error: ', ''))
                    ? t(`toast.${searchError.replace('Error: ', '')}`, { path: skillsDirPath })
                    : searchError}
                </span>
              </div>
            )}

            {searching && (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <LoadingSpinner size="lg" />
                <p className="mt-4 text-sm">{t('marketplace.searching')}</p>
              </div>
            )}

            {!searching && searchResults.length > 0 && (
              <div className="flex flex-col gap-1">
                {searchResults.map((skill) => {
                  const isInstalled = safeSkills.some((s) => s.id === skill.slug || s.name === skill.name);
                  const isInstallLoading = !!installing[skill.slug];

                  return (
                    <div
                      key={skill.slug}
                      className="group flex flex-row items-center justify-between py-3.5 px-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer border-b border-black/5 dark:border-white/5 last:border-0"
                      onClick={() => hostApi.shell.openExternal(`https://clawhub.ai/s/${skill.slug}`)}
                    >
                      <div className="flex items-start gap-4 flex-1 overflow-hidden pr-4">
                        <div className="h-10 w-10 shrink-0 flex items-center justify-center text-xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-xl overflow-hidden">
                          📦
                        </div>
                        <div className="flex flex-col overflow-hidden">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="text-sm font-semibold text-foreground truncate">{skill.name}</h3>
                            {skill.author && <span className="text-xs text-muted-foreground">• {skill.author}</span>}
                          </div>
                          <p className="text-sm text-muted-foreground line-clamp-1 pr-6 leading-relaxed">
                            {skill.description}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 shrink-0" onClick={(e) => e.stopPropagation()}>
                        {skill.version && (
                          <span className="text-meta font-mono text-muted-foreground mr-2">v{skill.version}</span>
                        )}
                        {isInstalled ? (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleUninstall(skill.slug)}
                            disabled={isInstallLoading}
                            className="h-8 shadow-none"
                          >
                            {isInstallLoading ? <LoadingSpinner size="sm" /> : <Trash2 className="h-3.5 w-3.5" />}
                          </Button>
                        ) : (
                          <Button
                            variant="default"
                            size="sm"
                            onClick={() => handleInstall(skill.slug)}
                            disabled={isInstallLoading}
                            className="h-8 px-4 rounded-full shadow-none font-medium text-xs"
                          >
                            {isInstallLoading ? <LoadingSpinner size="sm" /> : t('marketplace.install', 'Install')}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {!searching && searchResults.length === 0 && !searchError && (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <Package className="h-10 w-10 mb-4 opacity-50" />
                <p>{installQuery.trim() ? t('marketplace.noResults') : t('marketplace.emptyPrompt')}</p>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Skill Detail Dialog */}
      <SkillDetailDialog
        kernelOptions={kernelOptions}
        skill={selectedSkill}
        isOpen={!!selectedSkill}
        onClose={() => setSelectedSkill(null)}
        onToggle={(enabled) => {
          if (!selectedSkill) return;
          handleToggle(selectedSkill.id, enabled);
          setSelectedSkill({ ...selectedSkill, enabled });
        }}
        onUninstall={handleUninstall}
        onOpenFolder={handleOpenSkillFolder}
        onRetry={async (skillId, kernelId) => {
          try {
            const result = await retryProjection(skillId, kernelId);
            toast[mutationHasFailures(result) ? 'warning' : 'success'](
              mutationHasFailures(result) ? t('toast.kernelPartial') : t('toast.retrySucceeded'),
            );
          } catch (error) {
            toast.error(t('toast.retryFailed', { error: String(error) }));
          }
        }}
      />
    </div>
  );
}

export default Skills;
