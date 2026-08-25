/**
 * Settings Page
 * Application configuration
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Sun,
  Moon,
  Monitor,
  RefreshCw,
  Copy,
  Palette,
  RotateCcw,
  Type,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { useSettingsStore } from '@/stores/settings';
import { useUpdateStore } from '@/stores/update';
import { UpdateSettings } from '@/components/settings/UpdateSettings';
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
import { hostApi } from '@/lib/host-api';
import { cn } from '@/lib/utils';
import { DEFAULT_THEME_COLOR, normalizeThemeColor } from '@/lib/app-appearance';
import { KernelSettings } from '@/components/settings/KernelSettings';

export function Settings() {
  const { t, i18n } = useTranslation('settings');
  const {
    theme,
    setTheme,
    language,
    setLanguage,
    launchAtStartup,
    setLaunchAtStartup,
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

  const currentVersion = useUpdateStore((state) => state.currentVersion);
  const [proxyServerDraft, setProxyServerDraft] = useState('');
  const [proxyHttpServerDraft, setProxyHttpServerDraft] = useState('');
  const [proxyHttpsServerDraft, setProxyHttpsServerDraft] = useState('');
  const [proxyAllServerDraft, setProxyAllServerDraft] = useState('');
  const [proxyBypassRulesDraft, setProxyBypassRulesDraft] = useState('');
  const [proxyEnabledDraft, setProxyEnabledDraft] = useState(false);
  const [savingProxy, setSavingProxy] = useState(false);
  const [showTelemetryViewer, setShowTelemetryViewer] = useState(false);
  const [telemetryEntries, setTelemetryEntries] = useState<UiTelemetryEntry[]>([]);
  const [themeColorDraft, setThemeColorDraft] = useState(themeColor);

  const isMac = window.electron.platform === 'darwin';

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
    setThemeColorDraft(themeColor);
  }, [themeColor]);

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

  const proxySettingsDirty = useMemo(() => {
    return (
      proxyEnabledDraft !== proxyEnabled ||
      proxyServerDraft.trim() !== proxyServer ||
      proxyHttpServerDraft.trim() !== proxyHttpServer ||
      proxyHttpsServerDraft.trim() !== proxyHttpsServer ||
      proxyAllServerDraft.trim() !== proxyAllServer ||
      proxyBypassRulesDraft.trim() !== proxyBypassRules
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
      const durationMs = typeof entry.payload.durationMs === 'number' ? entry.payload.durationMs : Number.NaN;
      if (Number.isFinite(durationMs) && durationMs >= 800) {
        slowCount += 1;
      }
    }
    return { total: telemetryEntries.length, errorCount, slowCount };
  }, [telemetryEntries]);

  const telemetryByEvent = useMemo(() => {
    const map = new Map<
      string,
      {
        event: string;
        count: number;
        errorCount: number;
        slowCount: number;
        totalDuration: number;
        timedCount: number;
        lastTs: string;
      }
    >();

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

      const durationMs = typeof entry.payload.durationMs === 'number' ? entry.payload.durationMs : Number.NaN;
      if (Number.isFinite(durationMs)) {
        current.totalDuration += durationMs;
        current.timedCount += 1;
        if (durationMs >= 800) {
          current.slowCount += 1;
        }
      }

      map.set(entry.event, current);
    }

    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 12);
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
    const normalized = normalizeThemeColor(themeColorDraft);
    setThemeColor(normalized);
    setThemeColorDraft(normalized);
  };

  return (
    <div
      data-testid="settings-page"
      className="flex flex-col -m-6 dark:bg-background h-[calc(100vh-2.5rem)] overflow-hidden"
    >
      <div className="w-full max-w-5xl mx-auto flex flex-col h-full p-10 pt-16 pb-0">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-start justify-between mb-12 shrink-0 gap-4">
          <div>
            <h1 className="text-5xl md:text-6xl font-serif text-foreground mb-3 font-normal tracking-tight">
              {t('title')}
            </h1>
            <p className="text-subtitle text-foreground/70 font-medium">{t('subtitle')}</p>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto pr-2 pb-10 min-h-0 -mr-2 space-y-12">
          {/* Appearance */}
          <div>
            <h2 className="text-3xl font-serif text-foreground mb-6 font-normal tracking-tight">
              {t('appearance.title')}
            </h2>
            <div className="space-y-6">
              <div className="space-y-3">
                <Label className="text-sm font-medium text-foreground/80">{t('appearance.theme')}</Label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={theme === 'light' ? 'secondary' : 'outline'}
                    className={cn(
                      'rounded-full px-5 h-10 border-black/10 dark:border-white/10',
                      theme === 'light'
                        ? 'bg-black/5 dark:bg-white/10 text-foreground'
                        : 'bg-transparent text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5',
                    )}
                    onClick={() => setTheme('light')}
                  >
                    <Sun className="h-4 w-4 mr-2" />
                    {t('appearance.light')}
                  </Button>
                  <Button
                    variant={theme === 'dark' ? 'secondary' : 'outline'}
                    className={cn(
                      'rounded-full px-5 h-10 border-black/10 dark:border-white/10',
                      theme === 'dark'
                        ? 'bg-black/5 dark:bg-white/10 text-foreground'
                        : 'bg-transparent text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5',
                    )}
                    onClick={() => setTheme('dark')}
                  >
                    <Moon className="h-4 w-4 mr-2" />
                    {t('appearance.dark')}
                  </Button>
                  <Button
                    variant={theme === 'system' ? 'secondary' : 'outline'}
                    className={cn(
                      'rounded-full px-5 h-10 border-black/10 dark:border-white/10',
                      theme === 'system'
                        ? 'bg-black/5 dark:bg-white/10 text-foreground'
                        : 'bg-transparent text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5',
                    )}
                    onClick={() => setTheme('system')}
                  >
                    <Monitor className="h-4 w-4 mr-2" />
                    {t('appearance.system')}
                  </Button>
                </div>
              </div>

              {isMac ? (
                <div
                  className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
                  data-testid="settings-font-smoothing-row"
                >
                  <div>
                    <Label htmlFor="settings-font-smoothing-switch" className="text-sm font-medium text-foreground/80">
                      {t('appearance.fontSmoothing')}
                    </Label>
                    <p className="mt-1 text-meta text-muted-foreground">
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
              ) : null}

              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Type className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <Label htmlFor="settings-font-input" className="text-sm font-medium text-foreground/80">
                      {t('appearance.appFont')}
                    </Label>
                    <p className="mt-1 text-meta text-muted-foreground">
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
                    {appFontFamily.trim()
                      ? t('appearance.appFontPreview', { font: appFontFamily })
                      : t('appearance.systemFont')}
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Palette className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <Label htmlFor="settings-theme-color-text" className="text-sm font-medium text-foreground/80">
                      {t('appearance.themeColor')}
                    </Label>
                    <p className="mt-1 text-meta text-muted-foreground">
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
                    className="h-10 w-12 shrink-0 cursor-pointer p-1"
                  />
                  <Input
                    id="settings-theme-color-text"
                    data-testid="settings-theme-color-text"
                    value={themeColorDraft}
                    onChange={(event) => setThemeColorDraft(event.target.value)}
                    onBlur={commitThemeColorDraft}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitThemeColorDraft();
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
                <Label className="text-sm font-medium text-foreground/80">{t('appearance.language')}</Label>
                <div className="flex flex-wrap gap-2">
                  {SUPPORTED_LANGUAGES.map((lang) => (
                    <Button
                      key={lang.code}
                      variant={language === lang.code ? 'secondary' : 'outline'}
                      className={cn(
                        'rounded-full px-5 h-10 border-black/10 dark:border-white/10',
                        language === lang.code
                          ? 'bg-black/5 dark:bg-white/10 text-foreground'
                          : 'bg-transparent text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5',
                      )}
                      onClick={() => handleLanguageChange(lang.code)}
                    >
                      {lang.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium text-foreground/80">{t('appearance.launchAtStartup')}</Label>
                  <p className="text-meta text-muted-foreground mt-1">{t('appearance.launchAtStartupDesc')}</p>
                </div>
                <Switch checked={launchAtStartup} onCheckedChange={setLaunchAtStartup} />
              </div>
            </div>
          </div>

          <Separator className="bg-black/5 dark:bg-white/5" />

          <KernelSettings />

          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium text-foreground">{t('advanced.devMode')}</Label>
                <p className="text-meta text-muted-foreground mt-1">{t('advanced.devModeDesc')}</p>
              </div>
              <Switch checked={devModeUnlocked} onCheckedChange={setDevModeUnlocked} data-testid="settings-dev-mode-switch" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium text-foreground">{t('advanced.telemetry')}</Label>
                <p className="text-meta text-muted-foreground mt-1">{t('advanced.telemetryDesc')}</p>
              </div>
              <Switch checked={telemetryEnabled} onCheckedChange={setTelemetryEnabled} />
            </div>
          </div>

          {/* Developer */}
          {devModeUnlocked && (
            <>
              <Separator className="bg-black/5 dark:bg-white/5" />
              <div data-testid="settings-developer-section">
                <h2
                  data-testid="settings-developer-title"
                  className="text-3xl font-serif text-foreground mb-6 font-normal tracking-tight"
                >
                  {t('developer.title')}
                </h2>
                <div className="space-y-8">
                  {/* Gateway Proxy */}
                  <div className="space-y-4" data-testid="settings-proxy-section">
                    <div className="flex items-center justify-between">
                      <div>
                        <Label className="text-sm font-medium text-foreground/80">Gateway Proxy</Label>
                        <p className="text-meta text-muted-foreground">{t('gateway.proxyDesc')}</p>
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
                        className="rounded-xl h-10 px-5 bg-transparent border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        <RefreshCw className={`h-4 w-4 mr-2${savingProxy ? ' animate-spin' : ''}`} />
                        {savingProxy ? t('common:status.saving') : t('common:actions.save')}
                      </Button>
                      <p className="text-xs text-muted-foreground">{t('gateway.proxyRestartNote')}</p>
                    </div>

                    {proxyEnabledDraft && (
                      <div className="space-y-4 pt-2">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor="proxy-server" className="text-meta text-foreground/80">
                              {t('gateway.proxyServer')}
                            </Label>
                            <Input
                              id="proxy-server"
                              value={proxyServerDraft}
                              onChange={(event) => setProxyServerDraft(event.target.value)}
                              placeholder="http://127.0.0.1:7890"
                              className="h-10 rounded-xl bg-black/5 dark:bg-white/5 border-transparent font-mono text-meta"
                            />
                            <p className="text-tiny text-muted-foreground">{t('gateway.proxyServerHelp')}</p>
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="proxy-http-server" className="text-meta text-foreground/80">
                              {t('gateway.proxyHttpServer')}
                            </Label>
                            <Input
                              id="proxy-http-server"
                              value={proxyHttpServerDraft}
                              onChange={(event) => setProxyHttpServerDraft(event.target.value)}
                              placeholder={proxyServerDraft || 'http://127.0.0.1:7890'}
                              className="h-10 rounded-xl bg-black/5 dark:bg-white/5 border-transparent font-mono text-meta"
                            />
                            <p className="text-tiny text-muted-foreground">{t('gateway.proxyHttpServerHelp')}</p>
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="proxy-https-server" className="text-meta text-foreground/80">
                              {t('gateway.proxyHttpsServer')}
                            </Label>
                            <Input
                              id="proxy-https-server"
                              value={proxyHttpsServerDraft}
                              onChange={(event) => setProxyHttpsServerDraft(event.target.value)}
                              placeholder={proxyServerDraft || 'http://127.0.0.1:7890'}
                              className="h-10 rounded-xl bg-black/5 dark:bg-white/5 border-transparent font-mono text-meta"
                            />
                            <p className="text-tiny text-muted-foreground">{t('gateway.proxyHttpsServerHelp')}</p>
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="proxy-all-server" className="text-meta text-foreground/80">
                              {t('gateway.proxyAllServer')}
                            </Label>
                            <Input
                              id="proxy-all-server"
                              value={proxyAllServerDraft}
                              onChange={(event) => setProxyAllServerDraft(event.target.value)}
                              placeholder={proxyServerDraft || 'socks5://127.0.0.1:7891'}
                              className="h-10 rounded-xl bg-black/5 dark:bg-white/5 border-transparent font-mono text-meta"
                            />
                            <p className="text-tiny text-muted-foreground">{t('gateway.proxyAllServerHelp')}</p>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="proxy-bypass" className="text-meta text-foreground/80">
                            {t('gateway.proxyBypass')}
                          </Label>
                          <Input
                            id="proxy-bypass"
                            value={proxyBypassRulesDraft}
                            onChange={(event) => setProxyBypassRulesDraft(event.target.value)}
                            placeholder="<local>;localhost;127.0.0.1;::1"
                            className="h-10 rounded-xl bg-black/5 dark:bg-white/5 border-transparent font-mono text-meta"
                          />
                          <p className="text-tiny text-muted-foreground">{t('gateway.proxyBypassHelp')}</p>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <Label className="text-sm font-medium text-foreground">{t('developer.telemetryViewer')}</Label>
                        <p className="text-meta text-muted-foreground mt-1">{t('developer.telemetryViewerDesc')}</p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setShowTelemetryViewer((prev) => !prev)}
                        className="rounded-full px-5 h-9 bg-transparent border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        {showTelemetryViewer ? t('common:actions.hide') : t('common:actions.show')}
                      </Button>
                    </div>

                    {showTelemetryViewer && (
                      <div className="space-y-4 rounded-2xl border border-black/10 dark:border-white/10 p-5 bg-black/5 dark:bg-white/5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="secondary"
                            className="rounded-full px-3 py-1 bg-surface-modal border border-black/5 dark:border-white/5"
                          >
                            {t('developer.telemetryTotal')}: {telemetryStats.total}
                          </Badge>
                          <Badge
                            variant={telemetryStats.errorCount > 0 ? 'destructive' : 'secondary'}
                            className={cn(
                              'rounded-full px-3 py-1',
                              telemetryStats.errorCount === 0 &&
                                'bg-surface-modal border border-black/5 dark:border-white/5',
                            )}
                          >
                            {t('developer.telemetryErrors')}: {telemetryStats.errorCount}
                          </Badge>
                          <Badge
                            variant={telemetryStats.slowCount > 0 ? 'secondary' : 'outline'}
                            className={cn(
                              'rounded-full px-3 py-1',
                              telemetryStats.slowCount === 0 &&
                                'bg-surface-modal border border-black/5 dark:border-white/5',
                            )}
                          >
                            {t('developer.telemetrySlow')}: {telemetryStats.slowCount}
                          </Badge>
                          <div className="ml-auto flex gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={handleCopyTelemetry}
                              className="rounded-full h-8 px-4 bg-surface-modal border-black/5 dark:border-white/5 hover:bg-black/5 dark:hover:bg-white/10"
                            >
                              <Copy className="h-3.5 w-3.5 mr-1.5" />
                              {t('common:actions.copy')}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={handleClearTelemetry}
                              className="rounded-full h-8 px-4 bg-surface-modal border-black/5 dark:border-white/5 hover:bg-black/5 dark:hover:bg-white/10"
                            >
                              {t('common:actions.clear')}
                            </Button>
                          </div>
                        </div>

                        <div className="max-h-80 overflow-auto rounded-xl border border-black/10 dark:border-white/10 bg-surface-modal shadow-inner">
                          {telemetryByEvent.length > 0 && (
                            <div className="border-b border-black/5 dark:border-white/5 bg-black/5 dark:bg-white/5 p-3">
                              <p className="mb-3 text-xs font-semibold text-muted-foreground">
                                {t('developer.telemetryAggregated')}
                              </p>
                              <div className="space-y-1.5 text-xs">
                                {telemetryByEvent.map((item) => (
                                  <div
                                    key={item.event}
                                    className="grid grid-cols-[minmax(0,1.6fr)_0.7fr_0.9fr_0.8fr_1fr] gap-2 rounded-lg border border-black/5 dark:border-white/5 bg-surface-modal px-3 py-2"
                                  >
                                    <span className="truncate font-medium" title={item.event}>
                                      {item.event}
                                    </span>
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
                              <div className="text-muted-foreground text-center py-4">
                                {t('developer.telemetryEmpty')}
                              </div>
                            ) : (
                              telemetryEntries
                                .slice()
                                .reverse()
                                .map((entry) => (
                                  <div
                                    key={entry.id}
                                    className="rounded-lg border border-black/5 dark:border-white/5 bg-black/5 dark:bg-white/5 p-3"
                                  >
                                    <div className="flex items-center justify-between gap-3 mb-2">
                                      <span className="font-semibold text-foreground">{entry.event}</span>
                                      <span className="text-muted-foreground text-tiny">{entry.ts}</span>
                                    </div>
                                    <pre className="whitespace-pre-wrap text-tiny text-muted-foreground overflow-x-auto">
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
              </div>
            </>
          )}

          <Separator className="bg-black/5 dark:bg-white/5" />

          {/* Updates */}
          <div>
            <h2 className="text-3xl font-serif text-foreground mb-6 font-normal tracking-tight">
              {t('updates.title')}
            </h2>
            <div className="space-y-6">
              <UpdateSettings />

              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium text-foreground">{t('updates.autoCheck')}</Label>
                  <p className="text-meta text-muted-foreground mt-1">{t('updates.autoCheckDesc')}</p>
                </div>
                <Switch checked={autoCheckUpdate} onCheckedChange={setAutoCheckUpdate} />
              </div>
            </div>
          </div>

          <Separator className="bg-black/5 dark:bg-white/5" />

          {/* About */}
          <div>
            <h2 className="text-3xl font-serif text-foreground mb-6 font-normal tracking-tight">{t('about.title')}</h2>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                <strong className="text-foreground font-semibold">{t('about.appName')}</strong> - {t('about.tagline')}
              </p>
              <p>{t('about.basedOn')}</p>
              <p>{t('about.version', { version: currentVersion })}</p>
              <div className="flex gap-4 pt-3">
                <Button
                  variant="link"
                  className="h-auto p-0 text-sm text-blue-500 hover:text-blue-600 font-medium"
                  onClick={() => window.electron.openExternal('https://claw-x.com')}
                >
                  {t('about.docs')}
                </Button>
                <Button
                  variant="link"
                  className="h-auto p-0 text-sm text-blue-500 hover:text-blue-600 font-medium"
                  onClick={() => window.electron.openExternal('https://github.com/Tabll/ClawXXX')}
                >
                  {t('about.github')}
                </Button>
                <Button
                  variant="link"
                  className="h-auto p-0 text-sm text-blue-500 hover:text-blue-600 font-medium"
                  onClick={() =>
                    window.electron.openExternal('https://icnnp7d0dymg.feishu.cn/wiki/UyfOwQ2cAiJIP6kqUW8cte5Bnlc')
                  }
                >
                  {t('about.faq')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Settings;
