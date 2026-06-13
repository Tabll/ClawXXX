import { closeElectronApp, expect, test, getStableWindow } from './fixtures/electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test.describe('Appearance settings', () => {
  test('applies custom app font and theme color immediately', async ({ launchElectronApp, userDataDir }) => {
    await writeFile(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ language: 'en', themeColor: '#2563eb' }, null, 2),
      'utf-8',
    );

    const app = await launchElectronApp({ skipSetup: true });

    try {
      const page = await getStableWindow(app);

      await page.getByTestId('sidebar-nav-settings').click();
      await expect(page.getByTestId('settings-page')).toBeVisible();

      await expect(page.getByTestId('settings-theme-color-input')).toHaveValue('#111111');
      await expect.poll(() => page.evaluate(() => (
        getComputedStyle(document.documentElement).getPropertyValue('--appearance-primary').trim()
      ))).toBe('0 0% 7%');

      await page.getByTestId('settings-font-input').fill('Arial');
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).fontFamily))
        .toContain('Arial');

      await page.getByTestId('settings-theme-color-text').fill('#0f766e');
      await page.getByTestId('settings-theme-color-text').press('Enter');

      await expect.poll(() => page.evaluate(() => (
        document.documentElement.style.getPropertyValue('--appearance-primary').trim()
      ))).toContain('175');
      await expect(page.getByTestId('settings-theme-color-input')).toHaveValue('#0f766e');
    } finally {
      await closeElectronApp(app);
    }
  });
});
