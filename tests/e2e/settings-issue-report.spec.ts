import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

test('exports multi-kernel diagnostics without conversations and reports deleted selections', async ({ launchElectronApp, homeDir }) => {
  const app = await launchElectronApp({ skipSetup: true });
  try {
    const desktop = join(homeDir, 'report-desktop');
    await mkdir(desktop, { recursive: true });
    await app.evaluate(({ app }, path) => app.setPath('desktop', path), desktop);
    const page = await getStableWindow(app);
    await page.getByTestId('sidebar-nav-settings').click();
    await page.getByTestId('settings-issue-report-open').click();
    const dialog = page.getByTestId('issue-report-dialog');
    await expect(dialog).toContainText('Kernel status and versions');
    await dialog.getByRole('button', { name: 'Create ZIP without conversations', exact: true }).click();
    const path = await page.getByTestId('issue-report-path').innerText();
    expect(path.startsWith(desktop)).toBe(true);
    const zip = await JSZip.loadAsync(await readFile(path));
    expect(zip.file('diagnostics/kernels.json')).not.toBeNull();
    expect(zip.file(/^conversations\//)).toHaveLength(0);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('text'));
    expect(manifest.privacy.nativeHistoryRead).toBe(false);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    // A catalog item can disappear before export. Keep the exporter and
    // DataService real so missing selections are surfaced in the manifest/UI.
    await installIpcMocks(app, { hostApi: {
      '["conversations","list",{"limit":100}]': { items: [{
        id: 'deleted-after-list', title: 'Recently deleted conversation',
        createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z',
      }] },
    } });
    await page.getByTestId('settings-issue-report-open').click();
    await dialog.getByText('Recently deleted conversation', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Create ZIP (1)', exact: true }).click();
    await expect(page.getByTestId('issue-report-skipped-sessions')).toContainText('1');
    const secondPath = await page.getByTestId('issue-report-path').innerText();
    expect(secondPath).not.toEqual(path);
    const secondZip = await JSZip.loadAsync(await readFile(secondPath));
    const secondManifest = JSON.parse(await secondZip.file('manifest.json')!.async('text'));
    expect(secondManifest.skippedConversationIds).toEqual(['deleted-after-list']);
  } finally { await closeElectronApp(app); }
});
