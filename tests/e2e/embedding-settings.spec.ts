import { expect, test } from './fixtures/electron';

test.describe('Embedding model settings in Settings > Models', () => {
  async function openSettingsModels(page: import('@playwright/test').Page) {
    await page.getByTestId('sidebar-nav-settings').click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await page.getByTestId('settings-nav-models').click();
    await expect(page.getByTestId('settings-models-section')).toBeVisible();
  }

  test('shows embedding settings in the consolidated model settings section', async ({ page }) => {
    await expect(page.getByTestId('setup-page')).toBeVisible();
    await page.getByTestId('setup-skip-button').click();

    await expect(page.getByTestId('main-layout')).toBeVisible();
    await expect(page.getByTestId('sidebar-nav-embeddings')).toHaveCount(0);

    await page.evaluate(() => {
      window.location.hash = '#/embeddings';
    });

    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect(page.getByTestId('settings-models-section')).toBeVisible();
    await expect(page.getByTestId('embedding-settings')).toBeVisible();
    await expect(page.getByTestId('embedding-settings-title')).toBeVisible();
    await expect(page.getByTestId('embedding-provider')).toHaveValue('openai');
    await expect(page.getByTestId('embedding-model')).toHaveValue('text-embedding-3-small');
  });

  test('configures an OpenAI-compatible embedding endpoint without echoing the key', async ({ page }) => {
    await expect(page.getByTestId('setup-page')).toBeVisible();
    await page.getByTestId('setup-skip-button').click();

    await expect(page.getByTestId('main-layout')).toBeVisible();
    await openSettingsModels(page);

    await expect(page.getByTestId('embedding-settings')).toBeVisible();
    await page.getByTestId('embedding-provider').fill('openai-compatible');
    await expect(page.getByTestId('embedding-remote-section')).toBeVisible();
    await page.getByTestId('embedding-remote-base-url').fill('https://embeddings.example/v1');
    await page.getByTestId('embedding-model').fill('bge-m3');
    await page.getByTestId('embedding-remote-api-key').fill('sk-test-embedding');

    await expect(page.getByTestId('embedding-save')).toBeEnabled();
    await page.getByTestId('embedding-save').click();

    await expect(page.getByTestId('embedding-save')).toBeDisabled();
    await expect(page.getByTestId('embedding-remote-api-key')).toHaveValue('');
    await expect(page.getByTestId('embedding-api-key-status')).not.toBeEmpty();
    await expect(page.getByTestId('embedding-clear')).toBeEnabled();
  });
});
