import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { EmbeddingSettings } from '@/components/settings/EmbeddingSettings';
import { ProvidersSettings } from '@/components/settings/ProvidersSettings';
import { TokenUsageSettings } from '@/components/settings/TokenUsageSettings';
import { trackUiEvent } from '@/lib/telemetry';

export function Models() {
  const { t } = useTranslation(['dashboard', 'settings']);

  useEffect(() => {
    trackUiEvent('models.page_viewed');
  }, []);

  return (
    <div
      data-testid="models-page"
      className="flex flex-col -m-6 dark:bg-background h-[calc(100vh-2.5rem)] overflow-hidden"
    >
      <div className="w-full max-w-5xl mx-auto flex flex-col h-full p-10 pt-16 pb-0">
        <div className="flex flex-col md:flex-row md:items-start justify-between mb-12 shrink-0 gap-4">
          <div>
            <h1
              data-testid="models-page-title"
              className="text-5xl md:text-6xl font-serif text-foreground mb-3 font-normal tracking-tight"
            >
              {t('dashboard:models.title')}
            </h1>
            <p className="text-subtitle text-foreground/70 font-medium">
              {t('dashboard:models.subtitle')}
            </p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 pb-10 min-h-0 -mr-2 space-y-12">
          <ProvidersSettings />
          <EmbeddingSettings />
          <TokenUsageSettings />
        </div>
      </div>
    </div>
  );
}
