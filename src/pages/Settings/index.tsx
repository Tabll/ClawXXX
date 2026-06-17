/**
 * Settings Page
 * Application configuration
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  BarChart3,
  Cpu,
  Sun,
  Moon,
  Monitor,
  RefreshCw,
  ExternalLink,
  Copy,
  FileText,
  Info,
  Palette,
  RotateCcw,
  Server,
  SlidersHorizontal,
  Terminal,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { useSettingsStore } from '@/stores/settings';
import { useGatewayStore } from '@/stores/gateway';
import { useUpdateStore } from '@/stores/update';
import { UpdateSettings } from '@/components/settings/UpdateSettings';
import { ProvidersSettings } from '@/components/settings/ProvidersSettings';
import { ImageGenerationSettings } from '@/components/settings/ImageGenerationSettings';
import { EmbeddingSettings } from '@/components/settings/EmbeddingSettings';
import { TokenUsageSettings } from '@/components/settings/TokenUsageSettings';
import { toUserMessage } from '@/lib/error-message';
import {
  clearUiTelemetry,
  getUiTelemetrySnapshot,
  subscribeUiTelemetry,
  trackUiEvent,
  type UiTelemetryEntry,
} from '@/lib/telemetry';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { hostApi, type OpenClawDoctorResult } from '@/lib/host-api';
import { hostEvents } from '@/lib/host-events';
import { cn } from '@/lib/utils';
import { DEFAULT_THEME_COLOR, normalizeThemeColor } from '@/lib/app-appearance';

type ControlUiInfo = {
  url: string;
  token: string;
  port: number;
};

const SETTINGS_SECTIONS = ['appearance', 'gateway', 'models', 'tokenUsage', 'advanced', 'developer', 'about'] as const;
type SettingsSectionId = typeof SETTINGS_SECTIONS[number];

const SETTINGS_SECTION_ICONS: Record<SettingsSectionId, LucideIcon> = {
  appearance: Palette,
  gateway: Server,
  models: Cpu,
  tokenUsage: BarChart3,
  advanced: SlidersHorizontal,
  developer: Terminal,
  about: Info,
};

function isSettingsSectionId(value: string | undefined): value is SettingsSectionId {
  return SETTINGS_SECTIONS.includes(value as SettingsSectionId);
}

export function Settings() {
  const { t, i18n } = useTranslation(['settings', 'common', 'chat']);
  const navigate = useNavigate();
  const location = useLocation();
  const {
    theme,
    setTheme,
    language,
    setLanguage,
    launchAtStartup,
    setLaunchAtStartup,
    gatewayAutoStart,
    setGatewayAutoStart,
    proxyEnabled,
    proxyServer,
    proxyHttpServer,
    proxyHttpsServer,
    proxyAllServer,
    proxyBypassRules,
    setProxyEnabled,
    setProxyServer,
    setProxyHttpServer,
    setProxyHttpsServer,
    setProxyAllServer,
    setProxyBypassRules,
    autoCheckUpdate,
    setAutoCheckUpdate,
    devModeUnlocked,
    setDevModeUnlocked,
    telemetryEnabled,
    setTelemetryEnabled,
    appFontFamily,
    setAppFontFamily,
    themeColor,
    setThemeColor,
    macOSNativeFontSmoothing,
    setMacOSNativeFontSmoothing,
  } = useSettingsStore();

  const { status: gatewayStatus, restart: restartGateway } = useGatewayStore();
  const currentVersion = useUpdateStore((state) => state.currentVersion);
  const [controlUiInfo, setControlUiInfo] = useState<ControlUiInfo | null>(null);
  const [openclawCliCommand, setOpenclawCliCommand] = useState('');
  const [openclawCliError, setOpenclawCliError] = useState<string | null>(null);
  const [proxyServerDraft, setProxyServerDraft] = useState('');
  const [proxyHttpServerDraft, setProxyHttpServerDraft] = useState('');
  const [proxyHttpsServerDraft, setProxyHttpsServerDraft] = useState('');
  const [proxyAllServerDraft, setProxyAllServerDraft] = useState('');
  const [proxyBypassRulesDraft, setProxyBypassRulesDraft] = useState('');
  const [proxyEnabledDraft, setProxyEnabledDraft] = useState(false);
  const [savingProxy, setSavingProxy] = useState(false);
  const [showTelemetryViewer, setShowTelemetryViewer] = useState(false);
  const [telemetryEntries, setTelemetryEntries] = useState<UiTelemetryEntry[]>([]);

  const isWindows = window.electron.platform === 'win32';
  const showCliTools = true;
  const [showLogs, setShowLogs] = useState(false);
  const [logContent, setLogContent] = useState('');
  const [doctorRunningMode, setDoctorRunningMode] = useState<'diagnose' | 'fix' | null>(null);
  const [doctorResult, setDoctorResult] = useState<OpenClawDoctorResult | null>(null);
  const [themeColorDraft, setThemeColorDraft] = useState(themeColor);
  const pathSection = location.pathname.split('/').filter(Boolean)[1];
  const activeSection: SettingsSectionId = isSettingsSectionId(pathSection) ? pathSection : 'appearance';
  const isMac = window.electron?.platform === 'darwin';

  useEffect(() => {
    if (location.pathname === '/settings' || isSettingsSectionId(pathSection)) return;
    navigate('/settings/appearance', { replace: true });
  }, [location.pathname, navigate, pathSection]);

  const handleShowLogs = async () => {
    try {
      const logs = await hostApi.logs.recent(100);
      setLogContent(logs.content);
      setShowLogs(true);
    } catch {
      setLogContent('(Failed to load logs)');
      setShowLogs(true);
    }
  };

  const handleOpenLogDir = async () => {
    try {
      const { dir: logDir } = await hostApi.logs.dir();
      if (logDir) {
        await hostApi.shell.showItemInFolder(logDir);
      }
    } catch {
      // ignore
    }
  };

  const handleRunOpenClawDoctor = async (mode: 'diagnose' | 'fix') => {
    setDoctorRunningMode(mode);
    try {
      const result = await hostApi.app.openClawDoctor(mode);
      setDoctorResult(result);
      if (result.success) {
        toast.success(mode === 'fix' ? t('developer.doctorFixSucceeded') : t('developer.doctorSucceeded'));
      } else {
        toast.error(result.error || (mode === 'fix' ? t('developer.doctorFixFailed') : t('developer.doctorFailed')));
      }
    } catch (error) {
      const message = toUserMessage(error) || (mode === 'fix' ? t('developer.doctorFixRunFailed') : t('developer.doctorRunFailed'));
      toast.error(message);
      setDoctorResult({
        mode,
        success: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        command: 'openclaw doctor',
        cwd: '',
        durationMs: 0,
        error: message,
      });
    } finally {
      setDoctorRunningMode(null);
    }
  };

  const handleCopyDoctorOutput = async () => {
    if (!doctorResult) return;
    const payload = [
      `command: ${doctorResult.command}`,
      `cwd: ${doctorResult.cwd}`,
      `exitCode: ${doctorResult.exitCode ?? 'null'}`,
      `durationMs: ${doctorResult.durationMs}`,
      '',
      '[stdout]',
      doctorResult.stdout.trim() || '(empty)',
      '',
      '[stderr]',
      doctorResult.stderr.trim() || '(empty)',
    ].join('\n');

    try {
      await navigator.clipboard.writeText(payload);
      toast.success(t('developer.doctorCopied'));
    } catch (error) {
      toast.error(`Failed to copy doctor output: ${String(error)}`);
    }
  };



  const refreshControlUiInfo = async () => {
    try {
      const result = await hostApi.gateway.controlUi();
      if (result.success && result.url && result.token && typeof result.port === 'number') {
        setControlUiInfo({ url: result.url, token: result.token, port: result.port });
      }
    } catch {
      // Ignore refresh errors
    }
  };

  const handleCopyGatewayToken = async () => {
    if (!controlUiInfo?.token) return;
    try {
      await navigator.clipboard.writeText(controlUiInfo.token);
      toast.success(t('developer.tokenCopied'));
    } catch (error) {
      toast.error(`Failed to copy token: ${String(error)}`);
    }
  };

  useEffect(() => {
    if (!showCliTools) return;
    let cancelled = false;

    (async () => {
      try {
        const result = await hostApi.openclaw.getCliCommand();
        if (cancelled) return;
        if (result.success && result.command) {
          setOpenclawCliCommand(result.command);
          setOpenclawCliError(null);
        } else {
          setOpenclawCliCommand('');
          setOpenclawCliError(result.error || 'OpenClaw CLI unavailable');
        }
      } catch (error) {
        if (cancelled) return;
        setOpenclawCliCommand('');
        setOpenclawCliError(String(error));
      }
    })();

    return () => { cancelled = true; };
  }, [devModeUnlocked, showCliTools]);

  const handleCopyCliCommand = async () => {
    if (!openclawCliCommand) return;
    try {
      await navigator.clipboard.writeText(openclawCliCommand);
      toast.success(t('developer.cmdCopied'));
    } catch (error) {
      toast.error(`Failed to copy command: ${String(error)}`);
    }
  };

  useEffect(() => {
    const unsubscribe = hostEvents.onOpenClawCliInstalled((installedPath) => {
      toast.success(`openclaw CLI installed at ${installedPath}`);
    });
    return () => { unsubscribe?.(); };
  }, []);

  useEffect(() => {
    if (!devModeUnlocked) return;
    setTelemetryEntries(getUiTelemetrySnapshot(200));
    const unsubscribe = subscribeUiTelemetry((entry) => {
      setTelemetryEntries((prev) => {
        const next = [...prev, entry];
        if (next.length > 200) {
          next.splice(0, next.length - 200);
        }
        return next;
      });
    });
    return unsubscribe;
  }, [devModeUnlocked]);

  useEffect(() => {
    setProxyEnabledDraft(proxyEnabled);
  }, [proxyEnabled]);

  useEffect(() => {
    setProxyServerDraft(proxyServer);
  }, [proxyServer]);

  useEffect(() => {
    setProxyHttpServerDraft(proxyHttpServer);
  }, [proxyHttpServer]);

  useEffect(() => {
    setProxyHttpsServerDraft(proxyHttpsServer);
  }, [proxyHttpsServer]);

  useEffect(() => {
    setProxyAllServerDraft(proxyAllServer);
  }, [proxyAllServer]);

  useEffect(() => {
    setProxyBypassRulesDraft(proxyBypassRules);
  }, [proxyBypassRules]);

  useEffect(() => {
    setThemeColorDraft(themeColor);
  }, [themeColor]);

  const proxySettingsDirty = useMemo(() => {
    return (
      proxyEnabledDraft !== proxyEnabled
      || proxyServerDraft.trim() !== proxyServer
      || proxyHttpServerDraft.trim() !== proxyHttpServer
      || proxyHttpsServerDraft.trim() !== proxyHttpsServer
      || proxyAllServerDraft.trim() !== proxyAllServer
      || proxyBypassRulesDraft.trim() !== proxyBypassRules
    );
  }, [
    proxyAllServer,
    proxyAllServerDraft,
    proxyBypassRules,
    proxyBypassRulesDraft,
    proxyEnabled,
    proxyEnabledDraft,
    proxyHttpServer,
    proxyHttpServerDraft,
    proxyHttpsServer,
    proxyHttpsServerDraft,
    proxyServer,
    proxyServerDraft,
  ]);

  const handleSaveProxySettings = async () => {
    setSavingProxy(true);
    try {
      const normalizedProxyServer = proxyServerDraft.trim();
      const normalizedHttpServer = proxyHttpServerDraft.trim();
      const normalizedHttpsServer = proxyHttpsServerDraft.trim();
      const normalizedAllServer = proxyAllServerDraft.trim();
      const normalizedBypassRules = proxyBypassRulesDraft.trim();
      await hostApi.settings.setMany({
        proxyEnabled: proxyEnabledDraft,
        proxyServer: normalizedProxyServer,
        proxyHttpServer: normalizedHttpServer,
        proxyHttpsServer: normalizedHttpsServer,
        proxyAllServer: normalizedAllServer,
        proxyBypassRules: normalizedBypassRules,
      });

      setProxyServer(normalizedProxyServer);
      setProxyHttpServer(normalizedHttpServer);
      setProxyHttpsServer(normalizedHttpsServer);
      setProxyAllServer(normalizedAllServer);
      setProxyBypassRules(normalizedBypassRules);
      setProxyEnabled(proxyEnabledDraft);

      toast.success(t('gateway.proxySaved'));
      trackUiEvent('settings.proxy_saved', { enabled: proxyEnabledDraft });
    } catch (error) {
      toast.error(`${t('gateway.proxySaveFailed')}: ${toUserMessage(error)}`);
    } finally {
      setSavingProxy(false);
    }
  };

  const telemetryStats = useMemo(() => {
    let errorCount = 0;
    let slowCount = 0;
    for (const entry of telemetryEntries) {
      if (entry.event.endsWith('_error') || entry.event.includes('request_error')) {
        errorCount += 1;
      }
      const durationMs = typeof entry.payload.durationMs === 'number'
        ? entry.payload.durationMs
        : Number.NaN;
      if (Number.isFinite(durationMs) && durationMs >= 800) {
        slowCount += 1;
      }
    }
    return { total: telemetryEntries.length, errorCount, slowCount };
  }, [telemetryEntries]);

  const telemetryByEvent = useMemo(() => {
    const map = new Map<string, {
      event: string;
      count: number;
      errorCount: number;
      slowCount: number;
      totalDuration: number;
      timedCount: number;
      lastTs: string;
    }>();

    for (const entry of telemetryEntries) {
      const current = map.get(entry.event) ?? {
        event: entry.event,
        count: 0,
        errorCount: 0,
        slowCount: 0,
        totalDuration: 0,
        timedCount: 0,
        lastTs: entry.ts,
      };

      current.count += 1;
      current.lastTs = entry.ts;

      if (entry.event.endsWith('_error') || entry.event.includes('request_error')) {
        current.errorCount += 1;
      }

      const durationMs = typeof entry.payload.durationMs === 'number'
        ? entry.payload.durationMs
        : Number.NaN;
      if (Number.isFinite(durationMs)) {
        current.totalDuration += durationMs;
        current.timedCount += 1;
        if (durationMs >= 800) {
          current.slowCount += 1;
        }
      }

      map.set(entry.event, current);
    }

    return [...map.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }, [telemetryEntries]);

  const handleCopyTelemetry = async () => {
    try {
      const serialized = telemetryEntries.map((entry) => JSON.stringify(entry)).join('\n');
      await navigator.clipboard.writeText(serialized);
      toast.success(t('developer.telemetryCopied'));
    } catch (error) {
      toast.error(`${t('common:status.error')}: ${String(error)}`);
    }
  };

  const handleClearTelemetry = () => {
    clearUiTelemetry();
    setTelemetryEntries([]);
    toast.success(t('developer.telemetryCleared'));
  };

  const handleLanguageChange = (nextLanguage: string) => {
    if (nextLanguage === language) return;
    const translateNext = i18n.getFixedT(nextLanguage, 'settings');
    setLanguage(nextLanguage);
    toast.success(translateNext('appearance.menuLanguageUpdated'));
  };

  const commitThemeColorDraft = () => {
    const nextColor = normalizeThemeColor(themeColorDraft);
    setThemeColor(nextColor);
    setThemeColorDraft(nextColor);
  };

  const renderAppearanceSection = () => (
    <div data-testid="settings-appearance-section" className="space-y-5">
      <div className="space-y-3">
        <Label className="clawx-form-label">{t('appearance.theme')}</Label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={theme === 'light' ? 'secondary' : 'outline'}
            className={cn(
              'h-9 rounded-lg border-border/80 px-4 text-meta',
              theme === 'light'
                ? 'border-primary/45 bg-primary/10 text-primary shadow-none'
                : 'bg-surface-modal/70 text-muted-foreground hover:border-ring/35 hover:bg-surface-modal',
            )}
            onClick={() => setTheme('light')}
          >
            <Sun className="mr-2 h-4 w-4" />
            {t('appearance.light')}
          </Button>
          <Button
            variant={theme === 'dark' ? 'secondary' : 'outline'}
            className={cn(
              'h-9 rounded-lg border-border/80 px-4 text-meta',
              theme === 'dark'
                ? 'border-primary/45 bg-primary/10 text-primary shadow-none'
                : 'bg-surface-modal/70 text-muted-foreground hover:border-ring/35 hover:bg-surface-modal',
            )}
            onClick={() => setTheme('dark')}
          >
            <Moon className="mr-2 h-4 w-4" />
            {t('appearance.dark')}
          </Button>
          <Button
            variant={theme === 'system' ? 'secondary' : 'outline'}
            className={cn(
              'h-9 rounded-lg border-border/80 px-4 text-meta',
              theme === 'system'
                ? 'border-primary/45 bg-primary/10 text-primary shadow-none'
                : 'bg-surface-modal/70 text-muted-foreground hover:border-ring/35 hover:bg-surface-modal',
            )}
            onClick={() => setTheme('system')}
          >
            <Monitor className="mr-2 h-4 w-4" />
            {t('appearance.system')}
          </Button>
        </div>
      </div>

      {isMac && (
        <div className="clawx-settings-row" data-testid="settings-font-smoothing-row">
          <div>
            <Label htmlFor="settings-font-smoothing-switch" className="text-sm font-medium text-foreground">
              {t('appearance.fontSmoothing')}
            </Label>
            <p className="text-meta mt-1 text-muted-foreground">
              {t('appearance.fontSmoothingDesc')}
            </p>
          </div>
          <Switch
            id="settings-font-smoothing-switch"
            checked={macOSNativeFontSmoothing}
            onCheckedChange={setMacOSNativeFontSmoothing}
            data-testid="settings-font-smoothing-switch"
          />
        </div>
      )}

      <div className="clawx-settings-row flex-col items-stretch sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Type className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <Label htmlFor="settings-font-input" className="text-sm font-medium text-foreground">
              {t('appearance.appFont')}
            </Label>
            <p className="text-meta mt-1 text-muted-foreground">
              {t('appearance.appFontDesc')}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:max-w-sm">
          <div className="flex gap-2">
            <Input
              id="settings-font-input"
              data-testid="settings-font-input"
              value={appFontFamily}
              onChange={(event) => setAppFontFamily(event.target.value)}
              placeholder={t('appearance.appFontPlaceholder')}
              className="min-w-0"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => setAppFontFamily('')}
              aria-label={t('appearance.resetFont')}
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
          <p className="truncate text-tiny text-muted-foreground">
            {appFontFamily.trim() ? t('appearance.appFontPreview', { font: appFontFamily }) : t('appearance.systemFont')}
          </p>
        </div>
      </div>

      <div className="clawx-settings-row flex-col items-stretch sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Palette className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <Label htmlFor="settings-theme-color-text" className="text-sm font-medium text-foreground">
              {t('appearance.themeColor')}
            </Label>
            <p className="text-meta mt-1 text-muted-foreground">
              {t('appearance.themeColorDesc')}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-sm">
          <Input
            data-testid="settings-theme-color-input"
            type="color"
            value={normalizeThemeColor(themeColorDraft)}
            onChange={(event) => {
              setThemeColorDraft(event.target.value);
              setThemeColor(event.target.value);
            }}
            aria-label={t('appearance.themeColor')}
            className="h-9 w-11 shrink-0 cursor-pointer p-1"
          />
          <Input
            id="settings-theme-color-text"
            data-testid="settings-theme-color-text"
            value={themeColorDraft}
            onChange={(event) => setThemeColorDraft(event.target.value)}
            onBlur={commitThemeColorDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitThemeColorDraft();
              }
            }}
            placeholder={DEFAULT_THEME_COLOR}
            className="min-w-0 font-mono text-meta"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => {
              setThemeColor(DEFAULT_THEME_COLOR);
              setThemeColorDraft(DEFAULT_THEME_COLOR);
            }}
            aria-label={t('appearance.resetThemeColor')}
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <Label className="clawx-form-label">{t('appearance.language')}</Label>
        <div className="flex flex-wrap gap-2">
          {SUPPORTED_LANGUAGES.map((lang) => (
            <Button
              key={lang.code}
              variant={language === lang.code ? 'secondary' : 'outline'}
              className={cn(
                'h-9 rounded-lg border-border/80 px-4 text-meta',
                language === lang.code
                  ? 'border-primary/45 bg-primary/10 text-primary shadow-none'
                  : 'bg-surface-modal/70 text-muted-foreground hover:border-ring/35 hover:bg-surface-modal',
              )}
              onClick={() => handleLanguageChange(lang.code)}
            >
              {lang.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="clawx-settings-row">
        <div>
          <Label className="clawx-form-label">{t('appearance.launchAtStartup')}</Label>
          <p className="text-meta mt-1 text-muted-foreground">
            {t('appearance.launchAtStartupDesc')}
          </p>
        </div>
        <Switch
          checked={launchAtStartup}
          onCheckedChange={setLaunchAtStartup}
        />
      </div>
    </div>
  );

  const renderGatewaySection = () => (
    <div data-testid="settings-gateway-section" className="space-y-5">
      <div className="clawx-panel p-4">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <Label className="text-sm font-medium text-foreground">{t('gateway.status')}</Label>
            <p className="text-meta mt-1 text-muted-foreground">
              {t('gateway.port')}: {gatewayStatus.port}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-meta font-medium',
                gatewayStatus.state === 'running' && gatewayStatus.gatewayReady !== false
                  ? 'border-green-500/20 bg-green-500/10 text-green-700 dark:text-green-400'
                  : gatewayStatus.state === 'running'
                    ? 'border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-400'
                    : gatewayStatus.state === 'error'
                      ? 'border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-400'
                      : 'border-transparent bg-surface-input/70 text-muted-foreground',
              )}
            >
              <div
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  gatewayStatus.state === 'running' && gatewayStatus.gatewayReady !== false
                    ? 'bg-green-500'
                    : gatewayStatus.state === 'running'
                      ? 'bg-red-500'
                      : gatewayStatus.state === 'error'
                        ? 'bg-red-500'
                        : 'bg-muted-foreground',
                )}
              />
              {gatewayStatus.state === 'running' && gatewayStatus.gatewayReady === false ? 'starting' : gatewayStatus.state}
            </div>
            <Button variant="outline" size="sm" onClick={restartGateway} className="clawx-toolbar-button h-8">
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t('common:actions.restart')}
            </Button>
            <Button variant="outline" size="sm" onClick={handleShowLogs} className="clawx-toolbar-button h-8">
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              {t('gateway.logs')}
            </Button>
          </div>
        </div>
      </div>

      {showLogs && (
        <div className="rounded-lg border border-border/60 bg-surface-input/70 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-medium">{t('gateway.appLogs')}</p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" className="h-7 rounded-lg text-xs hover:bg-surface-input" onClick={handleOpenLogDir}>
                <ExternalLink className="mr-1.5 h-3 w-3" />
                {t('gateway.openFolder')}
              </Button>
              <Button variant="ghost" size="sm" className="h-7 rounded-lg text-xs hover:bg-surface-input" onClick={() => setShowLogs(false)}>
                {t('common:actions.close')}
              </Button>
            </div>
          </div>
          <pre className="max-h-60 overflow-auto rounded-lg border border-border/60 bg-surface-input p-4 font-mono text-xs whitespace-pre-wrap text-muted-foreground shadow-inner">
            {logContent || t('chat:noLogs')}
          </pre>
        </div>
      )}

      <div className="clawx-settings-row">
        <div>
          <Label className="text-sm font-medium text-foreground">{t('gateway.autoStart')}</Label>
          <p className="text-meta mt-1 text-muted-foreground">
            {t('gateway.autoStartDesc')}
          </p>
        </div>
        <Switch
          checked={gatewayAutoStart}
          onCheckedChange={setGatewayAutoStart}
        />
      </div>
    </div>
  );

  const renderModelsSection = () => (
    <div data-testid="settings-models-section" className="space-y-8">
      <ProvidersSettings />
      <ImageGenerationSettings />
      <EmbeddingSettings />
    </div>
  );

  const renderTokenUsageSection = () => (
    <TokenUsageSettings />
  );

  const renderAdvancedSection = () => (
    <div data-testid="settings-advanced-section" className="space-y-4">
      <div className="clawx-settings-row">
        <div>
          <Label className="text-sm font-medium text-foreground">{t('advanced.devMode')}</Label>
          <p className="text-meta mt-1 text-muted-foreground">
            {t('advanced.devModeDesc')}
          </p>
        </div>
        <Switch
          checked={devModeUnlocked}
          onCheckedChange={setDevModeUnlocked}
          data-testid="settings-dev-mode-switch"
        />
      </div>

      <div className="clawx-settings-row">
        <div>
          <Label className="text-sm font-medium text-foreground">{t('advanced.telemetry')}</Label>
          <p className="text-meta mt-1 text-muted-foreground">
            {t('advanced.telemetryDesc')}
          </p>
        </div>
        <Switch
          checked={telemetryEnabled}
          onCheckedChange={setTelemetryEnabled}
        />
      </div>
    </div>
  );

  const renderDeveloperSection = () => {
    if (!devModeUnlocked) {
      return (
        <div data-testid="settings-developer-locked" className="clawx-panel-muted p-5">
          <div className="max-w-2xl space-y-3">
            <h2 className="clawx-section-title">{t('developer.lockedTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('developer.lockedDescription')}</p>
            <Button
              type="button"
              variant="outline"
              className="rounded-lg"
              onClick={() => navigate('/settings/advanced')}
            >
              {t('developer.openAdvanced')}
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div data-testid="settings-developer-section" className="space-y-6">
        <div className="space-y-4" data-testid="settings-proxy-section">
          <div className="flex items-center justify-between">
            <div>
              <Label className="clawx-form-label">{t('gateway.proxyTitle')}</Label>
              <p className="text-meta text-muted-foreground">
                {t('gateway.proxyDesc')}
              </p>
            </div>
            <Switch
              checked={proxyEnabledDraft}
              onCheckedChange={setProxyEnabledDraft}
              data-testid="settings-proxy-toggle"
            />
          </div>

          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              onClick={handleSaveProxySettings}
              disabled={savingProxy || !proxySettingsDirty}
              data-testid="settings-proxy-save-button"
              className="h-9 rounded-lg border-border/80 bg-surface-modal/70 px-4 hover:border-ring/35 hover:bg-surface-modal"
            >
              <RefreshCw className={`mr-2 h-4 w-4${savingProxy ? ' animate-spin' : ''}`} />
              {savingProxy ? t('common:status.saving') : t('common:actions.save')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t('gateway.proxyRestartNote')}
            </p>
          </div>

          {proxyEnabledDraft && (
            <div className="space-y-4 pt-2">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="proxy-server" className="clawx-form-label text-meta">{t('gateway.proxyServer')}</Label>
                  <Input
                    id="proxy-server"
                    value={proxyServerDraft}
                    onChange={(event) => setProxyServerDraft(event.target.value)}
                    placeholder="http://127.0.0.1:7890"
                    className="h-9 rounded-lg border-border/80 bg-surface-modal/70 font-mono text-meta"
                  />
                  <p className="text-tiny text-muted-foreground">
                    {t('gateway.proxyServerHelp')}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="proxy-http-server" className="clawx-form-label text-meta">{t('gateway.proxyHttpServer')}</Label>
                  <Input
                    id="proxy-http-server"
                    value={proxyHttpServerDraft}
                    onChange={(event) => setProxyHttpServerDraft(event.target.value)}
                    placeholder={proxyServerDraft || 'http://127.0.0.1:7890'}
                    className="h-9 rounded-lg border-border/80 bg-surface-modal/70 font-mono text-meta"
                  />
                  <p className="text-tiny text-muted-foreground">
                    {t('gateway.proxyHttpServerHelp')}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="proxy-https-server" className="clawx-form-label text-meta">{t('gateway.proxyHttpsServer')}</Label>
                  <Input
                    id="proxy-https-server"
                    value={proxyHttpsServerDraft}
                    onChange={(event) => setProxyHttpsServerDraft(event.target.value)}
                    placeholder={proxyServerDraft || 'http://127.0.0.1:7890'}
                    className="h-9 rounded-lg border-border/80 bg-surface-modal/70 font-mono text-meta"
                  />
                  <p className="text-tiny text-muted-foreground">
                    {t('gateway.proxyHttpsServerHelp')}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="proxy-all-server" className="clawx-form-label text-meta">{t('gateway.proxyAllServer')}</Label>
                  <Input
                    id="proxy-all-server"
                    value={proxyAllServerDraft}
                    onChange={(event) => setProxyAllServerDraft(event.target.value)}
                    placeholder={proxyServerDraft || 'socks5://127.0.0.1:7891'}
                    className="h-9 rounded-lg border-border/80 bg-surface-modal/70 font-mono text-meta"
                  />
                  <p className="text-tiny text-muted-foreground">
                    {t('gateway.proxyAllServerHelp')}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="proxy-bypass" className="clawx-form-label text-meta">{t('gateway.proxyBypass')}</Label>
                <Input
                  id="proxy-bypass"
                  value={proxyBypassRulesDraft}
                  onChange={(event) => setProxyBypassRulesDraft(event.target.value)}
                  placeholder="<local>;localhost;127.0.0.1;::1"
                  className="h-9 rounded-lg border-border/80 bg-surface-modal/70 font-mono text-meta"
                />
                <p className="text-tiny text-muted-foreground">
                  {t('gateway.proxyBypassHelp')}
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4 pt-4">
          <Label className="clawx-form-label">{t('developer.gatewayToken')}</Label>
          <p className="text-meta text-muted-foreground">
            {t('developer.gatewayTokenDesc')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              data-testid="settings-developer-gateway-token"
              readOnly
              value={controlUiInfo?.token || ''}
              placeholder={t('developer.tokenUnavailable')}
              className="h-9 min-w-[200px] flex-1 rounded-lg border-border/80 bg-surface-modal/70 font-mono text-meta"
            />
            <Button
              type="button"
              variant="outline"
              onClick={refreshControlUiInfo}
              disabled={!devModeUnlocked}
              className="h-9 rounded-lg border-border/80 bg-surface-modal/70 px-3 hover:border-ring/35 hover:bg-surface-modal"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('common:actions.load')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleCopyGatewayToken}
              disabled={!controlUiInfo?.token}
              className="h-9 rounded-lg border-border/80 bg-surface-modal/70 px-3 hover:border-ring/35 hover:bg-surface-modal"
            >
              <Copy className="mr-2 h-4 w-4" />
              {t('common:actions.copy')}
            </Button>
          </div>
        </div>

        {showCliTools && (
          <div className="space-y-3">
            <Label className="text-sm font-medium text-foreground">{t('developer.cli')}</Label>
            <p className="text-meta text-muted-foreground">
              {t('developer.cliDesc')}
            </p>
            {isWindows && (
              <p className="text-xs text-muted-foreground">
                {t('developer.cliPowershell')}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Input
                readOnly
                value={openclawCliCommand}
                placeholder={openclawCliError || t('developer.cmdUnavailable')}
                className="h-9 min-w-[200px] flex-1 rounded-lg border-border/80 bg-surface-modal/70 font-mono text-meta"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleCopyCliCommand}
                disabled={!openclawCliCommand}
                className="h-9 rounded-lg border-border/80 bg-surface-modal/70 px-3 hover:border-ring/35 hover:bg-surface-modal"
              >
                <Copy className="mr-2 h-4 w-4" />
                {t('common:actions.copy')}
              </Button>
            </div>
          </div>
        )}

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label className="text-sm font-medium text-foreground">{t('developer.doctor')}</Label>
              <p className="text-meta mt-1 text-muted-foreground">
                {t('developer.doctorDesc')}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleRunOpenClawDoctor('diagnose')}
                disabled={doctorRunningMode !== null}
                className="h-9 rounded-lg border-border/80 bg-surface-modal/70 px-3 hover:border-ring/35 hover:bg-surface-modal"
              >
                <RefreshCw className={`mr-2 h-4 w-4${doctorRunningMode === 'diagnose' ? ' animate-spin' : ''}`} />
                {doctorRunningMode === 'diagnose' ? t('common:status.running') : t('developer.runDoctor')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleRunOpenClawDoctor('fix')}
                disabled={doctorRunningMode !== null}
                className="h-9 rounded-lg border-border/80 bg-surface-modal/70 px-3 hover:border-ring/35 hover:bg-surface-modal"
              >
                <RefreshCw className={`mr-2 h-4 w-4${doctorRunningMode === 'fix' ? ' animate-spin' : ''}`} />
                {doctorRunningMode === 'fix' ? t('common:status.running') : t('developer.runDoctorFix')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleCopyDoctorOutput}
                disabled={!doctorResult}
                className="h-9 rounded-lg border-border/80 bg-surface-modal/70 px-3 hover:border-ring/35 hover:bg-surface-modal"
              >
                <Copy className="mr-2 h-4 w-4" />
                {t('common:actions.copy')}
              </Button>
            </div>
          </div>

          {doctorResult && (
            <div className="space-y-3 rounded-lg border border-border/80 bg-surface-input/70 p-5">
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant={doctorResult.success ? 'secondary' : 'destructive'} className="rounded-full px-3 py-1">
                  {doctorResult.mode === 'fix'
                    ? (doctorResult.success ? t('developer.doctorFixOk') : t('developer.doctorFixIssue'))
                    : (doctorResult.success ? t('developer.doctorOk') : t('developer.doctorIssue'))}
                </Badge>
                <Badge variant="outline" className="rounded-full px-3 py-1">
                  {t('developer.doctorExitCode')}: {doctorResult.exitCode ?? 'null'}
                </Badge>
                <Badge variant="outline" className="rounded-full px-3 py-1">
                  {t('developer.doctorDuration')}: {Math.round(doctorResult.durationMs)}ms
                </Badge>
              </div>
              <div className="space-y-1 break-all font-mono text-xs text-muted-foreground">
                <p>{t('developer.doctorCommand')}: {doctorResult.command}</p>
                <p>{t('developer.doctorWorkingDir')}: {doctorResult.cwd || '-'}</p>
                {doctorResult.error && <p>{t('developer.doctorError')}: {doctorResult.error}</p>}
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-foreground/85">{t('developer.doctorStdout')}</p>
                  <pre className="max-h-72 overflow-auto rounded-lg border border-border/80 bg-surface-input p-3 font-mono text-tiny whitespace-pre-wrap break-words">
                    {doctorResult.stdout.trim() || t('developer.doctorOutputEmpty')}
                  </pre>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-foreground/85">{t('developer.doctorStderr')}</p>
                  <pre className="max-h-72 overflow-auto rounded-lg border border-border/80 bg-surface-input p-3 font-mono text-tiny whitespace-pre-wrap break-words">
                    {doctorResult.stderr.trim() || t('developer.doctorOutputEmpty')}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium text-foreground">{t('developer.telemetryViewer')}</Label>
              <p className="text-meta mt-1 text-muted-foreground">
                {t('developer.telemetryViewerDesc')}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowTelemetryViewer((prev) => !prev)}
              className="h-9 rounded-lg border-border/80 bg-surface-modal/70 px-5 hover:bg-surface-modal"
            >
              {showTelemetryViewer
                ? t('common:actions.hide')
                : t('common:actions.show')}
            </Button>
          </div>

          {showTelemetryViewer && (
            <div className="space-y-4 rounded-lg border border-border/80 bg-surface-input/70 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="rounded-full border border-border/60 bg-surface-modal px-3 py-1">{t('developer.telemetryTotal')}: {telemetryStats.total}</Badge>
                <Badge variant={telemetryStats.errorCount > 0 ? 'destructive' : 'secondary'} className={cn('rounded-full px-3 py-1', telemetryStats.errorCount === 0 && 'border border-border/60 bg-surface-modal')}>
                  {t('developer.telemetryErrors')}: {telemetryStats.errorCount}
                </Badge>
                <Badge variant={telemetryStats.slowCount > 0 ? 'secondary' : 'outline'} className={cn('rounded-full px-3 py-1', telemetryStats.slowCount === 0 && 'border border-border/60 bg-surface-modal')}>
                  {t('developer.telemetrySlow')}: {telemetryStats.slowCount}
                </Badge>
                <div className="ml-auto flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={handleCopyTelemetry} className="h-8 rounded-lg border-border/60 bg-surface-modal px-3 hover:bg-surface-input">
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                    {t('common:actions.copy')}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={handleClearTelemetry} className="h-8 rounded-lg border-border/60 bg-surface-modal px-3 hover:bg-surface-input">
                    {t('common:actions.clear')}
                  </Button>
                </div>
              </div>

              <div className="max-h-80 overflow-auto rounded-lg border border-border/80 bg-surface-modal shadow-inner">
                {telemetryByEvent.length > 0 && (
                  <div className="border-b border-border/60 bg-surface-input/70 p-3">
                    <p className="mb-3 text-xs font-semibold text-muted-foreground">
                      {t('developer.telemetryAggregated')}
                    </p>
                    <div className="space-y-1.5 text-xs">
                      {telemetryByEvent.map((item) => (
                        <div
                          key={item.event}
                          className="grid grid-cols-[minmax(0,1.6fr)_0.7fr_0.9fr_0.8fr_1fr] gap-2 rounded-lg border border-border/60 bg-surface-modal px-3 py-2"
                        >
                          <span className="truncate font-medium" title={item.event}>{item.event}</span>
                          <span className="text-muted-foreground">n={item.count}</span>
                          <span className="text-muted-foreground">
                            avg={item.timedCount > 0 ? Math.round(item.totalDuration / item.timedCount) : 0}ms
                          </span>
                          <span className="text-muted-foreground">slow={item.slowCount}</span>
                          <span className="text-muted-foreground">err={item.errorCount}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="space-y-2 p-3 font-mono text-xs">
                  {telemetryEntries.length === 0 ? (
                    <div className="py-4 text-center text-muted-foreground">{t('developer.telemetryEmpty')}</div>
                  ) : (
                    telemetryEntries
                      .slice()
                      .reverse()
                      .map((entry) => (
                        <div key={entry.id} className="rounded-lg border border-border/60 bg-surface-input/70 p-3">
                          <div className="mb-2 flex items-center justify-between gap-3">
                            <span className="font-semibold text-foreground">{entry.event}</span>
                            <span className="text-tiny text-muted-foreground">{entry.ts}</span>
                          </div>
                          <pre className="overflow-x-auto text-tiny whitespace-pre-wrap text-muted-foreground">
                            {JSON.stringify({ count: entry.count, ...entry.payload }, null, 2)}
                          </pre>
                        </div>
                      ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderAboutSection = () => (
    <div data-testid="settings-about-section" className="space-y-8">
      <div className="clawx-panel p-6">
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            <strong className="font-semibold text-foreground">{t('about.appName')}</strong> - {t('about.tagline')}
          </p>
          <p>{t('about.basedOn')}</p>
          <p>{t('about.version', { version: currentVersion })}</p>
          <div className="flex flex-wrap gap-4 pt-3">
            <Button
              variant="link"
              className="h-auto p-0 text-sm font-medium text-primary hover:text-primary/80"
              onClick={() => window.electron.openExternal('https://claw-x.com')}
            >
              {t('about.docs')}
            </Button>
            <Button
              variant="link"
              className="h-auto p-0 text-sm font-medium text-primary hover:text-primary/80"
              onClick={() => window.electron.openExternal('https://github.com/ValueCell-ai/ClawX')}
            >
              {t('about.github')}
            </Button>
            <Button
              variant="link"
              className="h-auto p-0 text-sm font-medium text-primary hover:text-primary/80"
              onClick={() => window.electron.openExternal('https://icnnp7d0dymg.feishu.cn/wiki/UyfOwQ2cAiJIP6kqUW8cte5Bnlc')}
            >
              {t('about.faq')}
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <h2 className="clawx-section-title">
          {t('updates.title')}
        </h2>
        <UpdateSettings />

        <div className="clawx-settings-row">
          <div>
            <Label className="text-sm font-medium text-foreground">{t('updates.autoCheck')}</Label>
            <p className="text-meta mt-1 text-muted-foreground">
              {t('updates.autoCheckDesc')}
            </p>
          </div>
          <Switch
            checked={autoCheckUpdate}
            onCheckedChange={setAutoCheckUpdate}
          />
        </div>
      </div>
    </div>
  );

  const renderActiveSection = () => {
    switch (activeSection) {
      case 'appearance':
        return renderAppearanceSection();
      case 'gateway':
        return renderGatewaySection();
      case 'models':
        return renderModelsSection();
      case 'tokenUsage':
        return renderTokenUsageSection();
      case 'advanced':
        return renderAdvancedSection();
      case 'developer':
        return renderDeveloperSection();
      case 'about':
        return renderAboutSection();
      default:
        return renderAppearanceSection();
    }
  };

  return (
    <div data-testid="settings-page" className="flex h-full min-h-0 bg-background">
      <aside
        data-testid="settings-sidebar"
        className={cn(
          'flex w-[252px] shrink-0 flex-col border-r border-border/65 bg-surface-sidebar/85 px-3 pb-4',
          isMac ? 'pt-9' : 'pt-4',
        )}
      >
        <button
          type="button"
          data-testid="settings-return-app"
          onClick={() => navigate('/')}
          className="clawx-nav-item mb-3 h-9 w-full justify-start px-3 text-meta"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('settingsNav.returnApp')}
        </button>

        <nav className="space-y-1" aria-label={t('title')}>
          {SETTINGS_SECTIONS.map((sectionId) => {
            const Icon = SETTINGS_SECTION_ICONS[sectionId];
            const selected = activeSection === sectionId;
            return (
              <button
                key={sectionId}
                type="button"
                data-testid={`settings-nav-${sectionId}`}
                onClick={() => navigate(`/settings/${sectionId}`)}
                className={cn(
                  'clawx-nav-item h-9 w-full justify-start px-3 text-meta font-medium',
                  selected && 'clawx-nav-item-active',
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="truncate">{t(`settingsNav.${sectionId}`)}</span>
              </button>
            );
          })}
        </nav>

        <div
          data-testid="settings-app-version"
          className="mt-auto border-t border-border/60 pt-4 text-xs font-medium text-muted-foreground"
        >
          {t('about.appName')} · {currentVersion}
        </div>
      </aside>

      <section data-testid="settings-content-scroll" className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col px-7 py-6">
          <div className="min-h-0 pb-8">
            {renderActiveSection()}
          </div>
        </div>
      </section>
    </div>
  );
}

export default Settings;
