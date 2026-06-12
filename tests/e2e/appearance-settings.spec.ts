import { closeElectronApp, expect, test, getStableWindow } from './fixtures/electron';

test.describe('Appearance settings', () => {
  test('applies custom app font and theme color immediately', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const page = await getStableWindow(app);

      await page.getByTestId('sidebar-nav-settings').click();
      await expect(page.getByTestId('settings-page')).toBeVisible();

      await page.getByTestId('settings-font-input').fill('Arial');
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).fontFamily))
        .toContain('Arial');

      await page.getByTestId('settings-theme-color-text').fill('#0f766e');
      await page.getByTestId('settings-theme-color-text').press('Enter');

      await expect.poll(() => page.evaluate(() => (
        document.documentElement.style.getPropertyValue('--primary').trim()
      ))).toContain('175');
      await expect(page.getByTestId('settings-theme-color-input')).toHaveValue('#0f766e');
    } finally {
      await closeElectronApp(app);
    }
  });
});
