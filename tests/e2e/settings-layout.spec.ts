import { completeSetup, expect, test } from './fixtures/electron';

test.describe('Full-screen settings layout', () => {
  test('uses a dedicated settings sidebar and consolidates model configuration', async ({ page }) => {
    await completeSetup(page);

    await page.getByTestId('sidebar-nav-settings').click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect(page.getByTestId('settings-sidebar')).toBeVisible();
    await expect(page.getByTestId('sidebar')).toHaveCount(0);
    await expect(page.getByTestId('settings-return-app')).toBeVisible();
    await expect(page.getByTestId('settings-app-version')).toContainText(/ClawX ·/);
    await expect(page.getByTestId('settings-section-title')).toHaveCount(0);

    for (const section of ['appearance', 'gateway', 'models', 'advanced', 'developer', 'about']) {
      await expect(page.getByTestId(`settings-nav-${section}`)).toBeVisible();
    }

    await page.getByTestId('settings-nav-models').click();
    await expect(page.getByTestId('settings-models-section')).toBeVisible();
    await expect(page.getByTestId('providers-settings')).toBeVisible();
    await expect(page.getByTestId('image-generation-settings')).toBeVisible();
    await expect(page.getByTestId('embedding-settings')).toBeVisible();

    await page.getByTestId('settings-return-app').click();
    await expect(page.getByTestId('chat-page')).toBeVisible();
    await expect(page.getByTestId('sidebar')).toBeVisible();
  });
});
