import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Download,
  Loader2,
  RefreshCw,
  RotateCw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { KernelCatalogEntry } from '@shared/host-api/kernels';
import { TitleBar } from '@/components/layout/TitleBar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { useKernelStore } from '@/stores/kernels';
import { useSettingsStore } from '@/stores/settings';
import { hostApi } from '@/lib/host-api';
import clawxIcon from '@/assets/logo.svg';

const STEP = { WELCOME: 0, CATALOG: 1, COMPLETE: 2 } as const;

export function Setup() {
  const { t } = useTranslation('setup');
  const navigate = useNavigate();
  const [step, setStep] = useState<number>(STEP.WELCOME);
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const markSetupComplete = useSettingsStore(state => state.markSetupComplete);
  const initKernels = useKernelStore(state => state.init);
  const refresh = useKernelStore(state => state.refresh);
  const catalog = useKernelStore(state => state.catalog);
  const pending = useKernelStore(state => state.pending);
  const errors = useKernelStore(state => state.errors);
  const progress = useKernelStore(state => state.progress);
  const restartRequired = useKernelStore(state => state.restartRequired);
  const install = useKernelStore(state => state.install);

  useEffect(() => { void initKernels(); }, [initKernels]);

  const entries = catalog?.entries ?? [];
  const anyPending = Object.values(pending).some(Boolean);
  const installedNames = entries
    .filter(entry => entry.installation.state === 'installed')
    .map(entry => entry.displayName);
  const needsRestart = Object.values(restartRequired).some(Boolean);

  const finish = () => {
    markSetupComplete();
    navigate('/');
  };

  const steps = useMemo(() => [
    t('steps.welcome.title'),
    t('steps.catalog.title'),
    t('steps.complete.title'),
  ], [t]);

  return (
    <div data-testid="setup-page" className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className="flex-1 overflow-auto">
        <div className="mx-auto flex max-w-3xl flex-col px-8 py-8">
          <div className="mb-8 flex justify-center gap-2" aria-label={t('progressLabel')}>
            {steps.map((label, index) => (
              <div key={label} className="flex items-center">
                <div
                  aria-current={index === step ? 'step' : undefined}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm transition-colors',
                    index < step && 'border-primary bg-primary text-primary-foreground',
                    index === step && 'border-primary text-primary',
                    index > step && 'border-muted-foreground/30 text-muted-foreground',
                  )}
                  title={label}
                >
                  {index < step ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                {index < steps.length - 1 && (
                  <div className={cn('h-0.5 w-12', index < step ? 'bg-primary' : 'bg-muted-foreground/30')} />
                )}
              </div>
            ))}
          </div>

          <section className="mb-8 text-center">
            <h1 className="mb-2 font-serif text-3xl font-normal tracking-tight">{steps[step]}</h1>
            <p className="text-muted-foreground">
              {step === STEP.WELCOME && t('steps.welcome.description')}
              {step === STEP.CATALOG && t('steps.catalog.description')}
              {step === STEP.COMPLETE && t('steps.complete.description')}
            </p>
          </section>

          <div className="mb-8 rounded-xl border bg-card p-8 text-card-foreground shadow-sm">
            {step === STEP.WELCOME && <Welcome />}
            {step === STEP.CATALOG && (
              <div data-testid="setup-kernel-catalog" className="space-y-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-serif text-xl font-normal tracking-tight">{t('catalog.title')}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{t('catalog.subtitle')}</p>
                  </div>
                  <Button variant="ghost" size="sm" disabled={anyPending} onClick={() => void refresh(true)}>
                    <RefreshCw className="mr-2 h-4 w-4" />{t('catalog.refresh')}
                  </Button>
                </div>

                {catalog?.warning && (
                  <div className="flex gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-400">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{catalog.warning}</span>
                  </div>
                )}

                <div className="grid gap-4 md:grid-cols-2">
                  {entries.map(entry => (
                    <KernelCard
                      key={entry.kernelId}
                      entry={entry}
                      skipped={skipped[entry.kernelId] === true}
                      pending={pending[entry.kernelId]}
                      error={errors[entry.kernelId]}
                      progress={progress[entry.kernelId]}
                      onInstall={() => void install(entry.kernelId)}
                      onSkip={() => setSkipped(current => ({
                        ...current,
                        [entry.kernelId]: !current[entry.kernelId],
                      }))}
                    />
                  ))}
                </div>

                <p className="text-xs leading-5 text-muted-foreground">{t('catalog.sharedData')}</p>
              </div>
            )}
            {step === STEP.COMPLETE && (
              <div data-testid="setup-complete-step" className="space-y-5 text-center">
                <CheckCircle2 className="mx-auto h-14 w-14 text-green-700 dark:text-green-400" />
                <div>
                  <h2 className="font-serif text-xl font-normal tracking-tight">{t('complete.title')}</h2>
                  <p className="mt-2 text-muted-foreground">{t('complete.subtitle')}</p>
                </div>
                <div className="rounded-lg bg-black/[0.04] p-4 text-left text-sm dark:bg-white/[0.08]">
                  <p className="font-medium">{t('complete.installed')}</p>
                  <p className="mt-1 text-muted-foreground">
                    {installedNames.length > 0 ? installedNames.join(', ') : t('complete.noneInstalled')}
                  </p>
                </div>
                {needsRestart && (
                  <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-4 text-left text-sm text-blue-700 dark:text-blue-400">
                    {t('complete.restartRequired')}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex justify-between">
            <div>
              {step > STEP.WELCOME && step < STEP.COMPLETE && (
                <Button variant="ghost" onClick={() => setStep(current => current - 1)} disabled={anyPending}>
                  <ChevronLeft className="mr-2 h-4 w-4" />{t('nav.back')}
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              {step < STEP.COMPLETE && (
                <Button data-testid="setup-skip-button" variant="ghost" onClick={finish} disabled={anyPending}>
                  {t('nav.skipSetup')}
                </Button>
              )}
              {step === STEP.WELCOME && (
                <Button data-testid="setup-next-button" onClick={() => setStep(STEP.CATALOG)}>
                  {t('nav.next')}<ChevronRight className="ml-2 h-4 w-4" />
                </Button>
              )}
              {step === STEP.CATALOG && (
                <Button data-testid="setup-next-button" onClick={() => setStep(STEP.COMPLETE)} disabled={anyPending}>
                  {t('catalog.continue')}<ChevronRight className="ml-2 h-4 w-4" />
                </Button>
              )}
              {step === STEP.COMPLETE && (
                needsRestart ? (
                  <Button data-testid="setup-relaunch-button" onClick={() => void hostApi.app.relaunch()}>
                    <RotateCw className="mr-2 h-4 w-4" />{t('complete.restartNow')}
                  </Button>
                ) : (
                  <Button data-testid="setup-next-button" onClick={finish}>{t('nav.getStarted')}</Button>
                )
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Welcome() {
  const { t } = useTranslation('setup');
  const language = useSettingsStore(state => state.language);
  const setLanguage = useSettingsStore(state => state.setLanguage);
  return (
    <div data-testid="setup-welcome-step" className="space-y-5 text-center">
      <img src={clawxIcon} alt="ClawX" className="mx-auto h-16 w-16" />
      <div>
        <h2 className="font-serif text-xl font-normal tracking-tight">{t('welcome.title')}</h2>
        <p className="mt-2 text-muted-foreground">{t('welcome.description')}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {SUPPORTED_LANGUAGES.map(item => (
          <Button
            key={item.code}
            variant={language === item.code ? 'secondary' : 'ghost'}
            size="sm"
            className={cn(language === item.code && 'bg-black/5 dark:bg-white/10')}
            onClick={() => setLanguage(item.code)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <div className="grid gap-3 pt-2 text-left sm:grid-cols-2">
        {(['optional', 'sharedUi', 'concurrent', 'offlineHistory'] as const).map(key => (
          <div key={key} className="flex gap-2 rounded-lg bg-black/[0.04] p-3 text-sm dark:bg-white/[0.08]">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-green-700 dark:text-green-400" />
            {t(`welcome.features.${key}`)}
          </div>
        ))}
      </div>
    </div>
  );
}

function KernelCard({
  entry,
  skipped,
  pending,
  error,
  progress,
  onInstall,
  onSkip,
}: {
  entry: KernelCatalogEntry;
  skipped: boolean;
  pending?: string;
  error?: string;
  progress?: { phase: string; receivedBytes: number; totalBytes: number };
  onInstall(): void;
  onSkip(): void;
}) {
  const { t } = useTranslation('setup');
  const installed = entry.installation.state === 'installed';
  const percent = progress?.totalBytes
    ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
    : undefined;
  return (
    <article
      data-testid={`setup-kernel-card-${entry.kernelId}`}
      className={cn('flex min-h-64 flex-col rounded-xl border p-4', skipped && 'opacity-70')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary"><Cpu className="h-5 w-5" /></div>
          <div>
            <h3 className="font-medium">{entry.displayName}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(`catalog.kernels.${entry.kernelId}.description`, { defaultValue: t('catalog.genericDescription') })}
            </p>
          </div>
        </div>
        <Badge variant="outline">{t('catalog.optional')}</Badge>
      </div>

      <dl className="mt-4 space-y-1 text-xs text-muted-foreground">
        <div className="flex justify-between gap-2"><dt>{t('catalog.installedVersion')}</dt><dd>{entry.installation.activeVersion ?? '—'}</dd></div>
        <div className="flex justify-between gap-2"><dt>{t('catalog.availableVersion')}</dt><dd>{entry.availableVersion ?? '—'}</dd></div>
      </dl>

      {progress && pending && (
        <div className="mt-4" data-testid={`setup-kernel-progress-${entry.kernelId}`}>
          <div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>{t(`catalog.phases.${progress.phase}`)}</span><span>{percent ?? 0}%</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${percent ?? 5}%` }} /></div>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-xs text-red-700 dark:text-red-400">{error}</p>}
      {entry.compatibilityFailures.length > 0 && (
        <p className="mt-3 text-xs text-yellow-700 dark:text-yellow-400">
          {t('catalog.incompatible', { reasons: entry.compatibilityFailures.join(', ') })}
        </p>
      )}

      <div className="mt-auto flex gap-2 pt-5">
        {installed ? (
          <Button className="flex-1" variant="secondary" disabled>
            <Check className="mr-2 h-4 w-4" />{t('catalog.installed')}
          </Button>
        ) : skipped ? (
          <Button data-testid={`setup-kernel-skip-${entry.kernelId}`} className="flex-1" variant="outline" onClick={onSkip}>
            {t('catalog.undoSkip')}
          </Button>
        ) : (
          <>
            <Button
              data-testid={`setup-kernel-install-${entry.kernelId}`}
              className="flex-1"
              disabled={!entry.installAllowed || Boolean(pending)}
              onClick={onInstall}
            >
              {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
              {pending ? t('catalog.installing') : t('catalog.install')}
            </Button>
            <Button data-testid={`setup-kernel-skip-${entry.kernelId}`} variant="ghost" disabled={Boolean(pending)} onClick={onSkip}>
              {t('catalog.skip')}
            </Button>
          </>
        )}
      </div>
    </article>
  );
}
