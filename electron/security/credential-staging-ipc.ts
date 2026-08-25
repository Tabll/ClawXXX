import { ipcMain, type BrowserWindow } from 'electron';
import type { CredentialStagingVault } from './credential-staging-vault';

const CHANNEL = 'credential:stage';

export function registerCredentialStagingIpc(
  mainWindow: BrowserWindow,
  vault: CredentialStagingVault,
): () => void {
  ipcMain.removeHandler(CHANNEL);
  ipcMain.handle(CHANNEL, (event, payload: unknown) => {
    if (event.sender.id !== mainWindow.webContents.id
      || !payload
      || typeof payload !== 'object'
      || typeof (payload as { value?: unknown }).value !== 'string') {
      throw new Error('Invalid secure credential staging request');
    }
    return { handle: vault.stage((payload as { value: string }).value) };
  });
  const clear = () => vault.clear();
  mainWindow.once('closed', clear);
  return () => {
    mainWindow.off('closed', clear);
    ipcMain.removeHandler(CHANNEL);
    vault.clear();
  };
}
