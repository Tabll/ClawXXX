import type { ElectronApplication, Page } from '@playwright/test';
import { closeElectronApp, expect, getStableWindow, installAttachmentHostFixture, installIpcMocks, test } from './fixtures/electron';

const TRANSCRIBED_TEXT = 'voice dictation result';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

async function stubMicrophoneCapture(page: Page, denyFirst = false): Promise<void> {
  await page.addInitScript((deny) => {
    let first = deny;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        ...navigator.mediaDevices,
        getUserMedia: async () => {
          if (first) { first = false; throw new DOMException('Denied', 'NotAllowedError'); }
          const context = new AudioContext();
          const oscillator = context.createOscillator();
          const destination = context.createMediaStreamDestination();
          oscillator.connect(destination);
          oscillator.start();
          return destination.stream;
        },
      },
    });
  }, denyFirst);
}

// The transcribe payload embeds recording bytes, so its hostApi mock key is
// not stable; intercept asr.transcribe dynamically and fall through to the
// previously installed host:invoke handler for everything else.
async function installAsrTranscribeMock(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(async ({ app: _app }, transcribed) => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
    type HostRequest = {
      id?: string;
      module?: string;
      action?: string;
      payload?: Record<string, unknown>;
    };
    type HostHandler = (event: unknown, request: HostRequest) => Promise<unknown>;
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, HostHandler> })._invokeHandlers;
    const previousHostInvoke = handlers?.get('host:invoke');

    ipcMain.removeHandler('host:invoke');
    ipcMain.handle('host:invoke', async (event: unknown, request: HostRequest) => {
      if (request.module === 'asr' && request.action === 'transcribe') {
        return {
          id: typeof request.id === 'string' ? request.id : undefined,
          ok: true,
          data: { text: transcribed },
        };
      }
      return previousHostInvoke?.(event, request) ?? { id: request.id, ok: true, data: {} };
    });
  }, text);
}

async function reloadRenderer(page: Page): Promise<void> {
  try {
    await page.reload();
  } catch (error) {
    if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
      throw error;
    }
  }
}

async function enableDeveloperMode(page: Page): Promise<void> {
  await expect(page.getByTestId('main-layout')).toBeVisible();
  await page.getByTestId('sidebar-nav-settings').click();
  const devModeSwitch = page.getByTestId('settings-dev-mode-switch');
  await expect(devModeSwitch).toBeVisible();
  if (await devModeSwitch.getAttribute('data-state') !== 'checked') {
    await devModeSwitch.click();
  }
  await expect(devModeSwitch).toHaveAttribute('data-state', 'checked');
  await page.evaluate(() => {
    window.location.hash = '#/';
  });
}

async function installConversationFixture(app: ElectronApplication): Promise<void> {
  await installAttachmentHostFixture(app, {
    sessions: [{ key: 'agent:main:voice-test', title: 'Voice input' }],
  });
}

test.describe('ClawX voice dictation', () => {
  for (const firstUse of [false, true]) {
    test(`guides ${firstUse ? 'newly' : 'previously'} denied permission and recovers on explicit retry`, async ({ launchElectronApp }) => {
      const app = await launchElectronApp({ skipSetup: true });
      try {
        await installConversationFixture(app);
        await installIpcMocks(app, {
          gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
          hostApi: { [stableStringify(['asr', 'getConfig', null])]: { configured: true, config: null, hasApiKey: true } },
        });
        await installAsrTranscribeMock(app, TRANSCRIBED_TEXT);
        await app.evaluate(({ ipcMain }, first) => {
          const state = { reads: 0, opens: 0, granted: false };
          (globalThis as unknown as { micTest: typeof state }).micTest = state;
          const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, request: { module: string; action: string; id: string }) => unknown> })._invokeHandlers;
          const previous = handlers.get('host:invoke')!;
          ipcMain.removeHandler('host:invoke');
          ipcMain.handle('host:invoke', (event, request) => {
            if (request.module === 'asr' && request.action === 'getMicrophoneAccess') {
              state.reads++;
              return { id: request.id, ok: true, data: { platform: 'darwin', status: state.granted ? 'granted' : first && state.reads === 1 ? 'not-determined' : 'denied', canOpenSettings: true } };
            }
            if (request.module === 'asr' && request.action === 'openMicrophoneSettings') {
              state.opens++;
              return { id: request.id, ok: true, data: { opened: false } };
            }
            return previous(event, request);
          });
        }, firstUse);
        const page = await getStableWindow(app);
        await stubMicrophoneCapture(page, firstUse);
        await reloadRenderer(page);
        await enableDeveloperMode(page);
        const composer = page.getByTestId('chat-composer-input');
        const voice = page.getByTestId('chat-composer-voice');
        await composer.fill('draft');
        await voice.click();
        const dialog = page.getByTestId('microphone-permission-dialog');
        await expect(dialog).toBeVisible();
        // DialogContent supplies positioning only; missing card styles otherwise
        // produce a full-window white strip while all interaction tests still pass.
        await expect.poll(() => dialog.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            bounded: bounds.width <= 560 && bounds.width <= innerWidth - 32,
            centered: Math.abs(bounds.x + bounds.width / 2 - innerWidth / 2) < 2
              && Math.abs(bounds.y + bounds.height / 2 - innerHeight / 2) < 2,
            withinViewport: bounds.top >= 16 && bounds.bottom <= innerHeight - 16,
            padded: parseFloat(style.paddingLeft) >= 24 && parseFloat(style.paddingRight) >= 24
              && parseFloat(style.paddingTop) >= 24 && parseFloat(style.paddingBottom) >= 24,
            rounded: parseFloat(style.borderTopLeftRadius) >= 8,
          };
        })).toEqual({ bounded: true, centered: true, withinViewport: true, padded: true, rounded: true });
        await expect(dialog).toContainText('Microphone access was denied.');
        await expect(dialog).not.toContainText('IDE or terminal');
        await expect(dialog).not.toContainText('restart ClawX');
        await expect(dialog).not.toContainText('Recording will not start automatically.');
        expect(await app.evaluate(() => (globalThis as unknown as { micTest: { opens: number } }).micTest.opens)).toBe(0);
        await dialog.getByRole('button', { name: 'Open system settings' }).click();
        await expect(dialog.getByRole('alert')).toContainText('Could not open');
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await composer.fill('editable ');
        await expect(voice).toHaveAttribute('title', 'Voice input');
        await app.evaluate(() => { (globalThis as unknown as { micTest: { granted: boolean } }).micTest.granted = true; });
        await voice.click();
        await expect(voice).toHaveAttribute('title', 'Stop recording');
        await expect(voice).toContainText('0:01');
        await voice.click();
        await expect(composer).toHaveValue(`editable ${TRANSCRIBED_TEXT}`);
      } finally { await closeElectronApp(app); }
    });
  }
  test('inserts transcribed text at cursor after recording', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installConversationFixture(app);
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        hostApi: {
          [stableStringify(['asr', 'getConfig', null])]: {
            configured: true,
            config: {
              preset: 'siliconflow',
              baseUrl: 'https://api.siliconflow.cn/v1',
              model: 'Qwen/Qwen3-ASR-1.7B',
            },
            hasApiKey: true,
          },
        },
      });
      await installAsrTranscribeMock(app, TRANSCRIBED_TEXT);

      const page = await getStableWindow(app);
      await stubMicrophoneCapture(page);
      await reloadRenderer(page);
      await enableDeveloperMode(page);

      const composer = page.getByTestId('chat-composer-input');
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await composer.fill('hello ');

      const voiceButton = page.getByTestId('chat-composer-voice');
      await expect(voiceButton).toHaveAttribute('title', 'Voice input');
      await voiceButton.click();
      await expect(voiceButton).toHaveAttribute('title', 'Stop recording');
      await expect(voiceButton).toContainText('0:01');

      await voiceButton.click();
      await expect(composer).toHaveValue(`hello ${TRANSCRIBED_TEXT}`);
      await expect(voiceButton).toHaveAttribute('title', 'Voice input');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('stages credentials securely and transcribes through the real Main service', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installConversationFixture(app);
      const endpoint = await app.evaluate(async ({ safeStorage }) => {
        // Keep this isolated test away from the user's OS keychain. The actual
        // staging vault, secret envelope persistence and ASR service stay real;
        // only the native cipher is replaced by a per-process test cipher.
        const crypto = process.mainModule!.require('node:crypto') as typeof import('node:crypto');
        const key = crypto.randomBytes(32);
        safeStorage.isEncryptionAvailable = () => true;
        safeStorage.encryptString = value => {
          const iv = crypto.randomBytes(12);
          const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
          const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
          return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
        };
        safeStorage.decryptString = value => {
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
          decipher.setAuthTag(value.subarray(12, 28));
          return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
        };
        const http = process.mainModule!.require('node:http') as typeof import('node:http');
        const server = http.createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on('data', chunk => chunks.push(Buffer.from(chunk)));
          request.on('end', () => {
            const valid = request.url === '/transcribe' && request.method === 'POST'
              && request.headers.authorization === 'Bearer fake-asr-e2e-key'
              && Buffer.concat(chunks).includes(Buffer.from('RIFF'));
            response.writeHead(valid ? 200 : 400, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ text: valid ? 'main service transcript' : '' }));
          });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as { port: number };
        return `http://127.0.0.1:${address.port}/transcribe`;
      });
      const page = await getStableWindow(app);
      await stubMicrophoneCapture(page);
      await reloadRenderer(page);
      await enableDeveloperMode(page);
      await page.getByTestId('sidebar-nav-models').click();
      await page.getByTestId('models-tab-voice').click();
      await page.getByTestId('asr-preset-select').selectOption('custom');
      await page.getByTestId('asr-base-url-input').fill(endpoint);
      await page.getByTestId('asr-model-input').fill('test-whisper');
      await page.getByTestId('asr-api-key-input').evaluate(element => {
        const id = element.getAttribute('data-clawx-secret-id');
        if (!id || !window.clawxSecureSecrets?.setValueForTesting) throw new Error('Secure test bridge unavailable');
        window.clawxSecureSecrets.setValueForTesting(id, 'fake-asr-e2e-key');
      });
      await page.getByTestId('asr-save-button').click();
      await expect(page.locator('[data-sonner-toast]')).toContainText('saved');
      const readiness = await page.evaluate(async () => window.clawx!.hostInvoke({
        id: crypto.randomUUID(), module: 'asr', action: 'getConfig',
      }));
      expect(readiness).toMatchObject({ ok: true, data: { configured: true, hasApiKey: true } });
      expect(JSON.stringify(readiness)).not.toContain('fake-asr-e2e-key');
      await page.evaluate(() => { window.location.hash = '#/'; });
      const composer = page.getByTestId('chat-composer-input');
      await composer.fill('Prefix ');
      const voice = page.getByTestId('chat-composer-voice');
      await voice.click();
      await expect(voice).toContainText('0:01');
      await voice.click();
      await expect(composer).toHaveValue('Prefix main service transcript');
    } finally { await closeElectronApp(app); }
  });

  test('guides to the models voice tab when asr is unconfigured', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installConversationFixture(app);
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        hostApi: {
          [stableStringify(['asr', 'getConfig', null])]: {
            configured: false,
            config: null,
            hasApiKey: false,
          },
        },
      });

      const page = await getStableWindow(app);
      await reloadRenderer(page);
      await enableDeveloperMode(page);

      const composer = page.getByTestId('chat-composer-input');
      await expect(composer).toBeVisible({ timeout: 30_000 });

      await page.getByTestId('chat-composer-voice').click();
      await expect(page.locator('[data-sonner-toast]')).toContainText('not configured');
      await expect(page).toHaveURL(/\/models/);
      await expect(page).toHaveURL(/tab=voice/);
      await expect(page.getByTestId('asr-settings')).toBeVisible();

      await expect(page.getByTestId('asr-protocol-select')).toHaveValue('transcriptions');
      await expect(page.getByTestId('asr-base-url-suffix')).toBeVisible();

      await page.getByTestId('asr-protocol-select').selectOption('chat');
      await expect(page.getByTestId('asr-preset-select')).toContainText('Alibaba Cloud Model Studio');
      await expect(page.getByTestId('asr-base-url-input')).toHaveValue(
        'https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      );
      await expect(page.getByTestId('asr-base-url-suffix')).toHaveCount(0);
      await expect(page.getByTestId('asr-bailian-dialect-hint')).toBeVisible();
      await expect(page.getByTestId('asr-bailian-docs-link')).toBeVisible();
      await expect(page.getByTestId('asr-bailian-workspace-hint')).toBeVisible();
      await expect(page.getByTestId('asr-api-key-link')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
