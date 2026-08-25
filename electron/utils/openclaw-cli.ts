/** OpenClaw CLI integration for an optional, verified managed runtime. */
import { app } from 'electron';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn, type ForkOptions } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
  buildManagedOpenClawEnvironment,
  getOpenClawRuntimeLocation,
  requireOpenClawRuntimeLocation,
} from '../kernels/openclaw/runtime-location';
import { logger } from './logger';

const CLI_MARKER = 'ClawX managed OpenClaw CLI';

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function getOpenClawCliTargetPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return join(app.getPath('userData'), 'bin', 'openclaw.cmd');
  return join(homedir(), '.local', 'bin', 'openclaw');
}

function isManagedWrapper(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(CLI_MARKER);
  } catch {
    return false;
  }
}

export function getOpenClawCliCommand(): string {
  const location = requireOpenClawRuntimeLocation();
  const wrapper = getOpenClawCliTargetPath();
  if (existsSync(wrapper) && isManagedWrapper(wrapper)) {
    return process.platform === 'win32'
      ? `& ${quotePowerShell(wrapper)}`
      : quotePosix(wrapper);
  }
  if (process.platform === 'win32') {
    return `& ${quotePowerShell(location.nodeExecutable)} ${quotePowerShell(location.entryPath)}`;
  }
  return `${quotePosix(location.nodeExecutable)} ${quotePosix(location.entryPath)}`;
}

export type OpenClawCliSpawnSpec = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
};

type OpenClawEmbeddedForkOptions = ForkOptions & { windowsHide?: boolean };

export type OpenClawEmbeddedForkSpec = {
  modulePath: string;
  args: string[];
  options: OpenClawEmbeddedForkOptions;
};

export function getOpenClawCliSpawnSpec(): OpenClawCliSpawnSpec {
  const location = requireOpenClawRuntimeLocation();
  const wrapper = getOpenClawCliTargetPath();
  if (existsSync(wrapper) && isManagedWrapper(wrapper)) {
    if (process.platform === 'win32') {
      return {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', `"${wrapper}"`],
      };
    }
    return { command: wrapper, args: [], shell: false };
  }
  return {
    command: location.nodeExecutable,
    args: [location.entryPath],
    env: buildManagedOpenClawEnvironment(location),
    shell: false,
  };
}

export function getOpenClawEmbeddedForkSpec(args: string[] = []): OpenClawEmbeddedForkSpec {
  const location = requireOpenClawRuntimeLocation();
  return {
    modulePath: location.entryPath,
    args,
    options: {
      cwd: location.packageDir,
      env: buildManagedOpenClawEnvironment(location),
      execPath: location.nodeExecutable,
      execArgv: [],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    },
  };
}

function posixWrapper(nodeExecutable: string, entryPath: string, stateRoot: string, cacheRoot: string): string {
  return `#!/bin/sh
# ${CLI_MARKER}. Regenerated after kernel activation.
export CLAWX_MANAGED_RUNTIME=1
export CLAWX_CONVERSATION_STORE_PROTOCOL=clawx.conversation-store/v1
export OPENCLAW_STATE_DIR=${quotePosix(stateRoot)}
export OPENCLAW_CONFIG_PATH=${quotePosix(join(stateRoot, 'openclaw.json'))}
export OPENCLAW_CACHE_DIR=${quotePosix(cacheRoot)}
export OPENCLAW_HISTORY_MODE=clawx-data-service
export OPENCLAW_DISABLE_NATIVE_HISTORY=1
export OPENCLAW_DISABLE_CRON_HISTORY=1
export OPENCLAW_DISABLE_TRANSCRIPT_USAGE_SCAN=1
exec ${quotePosix(nodeExecutable)} ${quotePosix(entryPath)} "$@"
`;
}

function windowsWrapper(nodeExecutable: string, entryPath: string, stateRoot: string, cacheRoot: string): string {
  return `@echo off
rem ${CLI_MARKER}. Regenerated after kernel activation.
setlocal
set "CLAWX_MANAGED_RUNTIME=1"
set "CLAWX_CONVERSATION_STORE_PROTOCOL=clawx.conversation-store/v1"
set "OPENCLAW_STATE_DIR=${stateRoot}"
set "OPENCLAW_CONFIG_PATH=${join(stateRoot, 'openclaw.json')}"
set "OPENCLAW_CACHE_DIR=${cacheRoot}"
set "OPENCLAW_HISTORY_MODE=clawx-data-service"
set "OPENCLAW_DISABLE_NATIVE_HISTORY=1"
set "OPENCLAW_DISABLE_CRON_HISTORY=1"
set "OPENCLAW_DISABLE_TRANSCRIPT_USAGE_SCAN=1"
"${nodeExecutable}" "${entryPath}" %*
set "CLAWX_EXIT=%ERRORLEVEL%"
endlocal & exit /b %CLAWX_EXIT%
`;
}

function getWindowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function getPathHelper(): string | undefined {
  if (!app.isPackaged) return undefined;
  const candidates = [
    join(process.resourcesPath, 'cli', 'update-user-path.ps1'),
    join(process.resourcesPath, 'resources', 'cli', 'win32', 'update-user-path.ps1'),
  ];
  return candidates.find(existsSync);
}

async function updateWindowsUserPath(action: 'add' | 'remove', cliDir: string): Promise<void> {
  const helper = getPathHelper();
  if (!helper) {
    logger.warn('Windows CLI PATH helper is unavailable; wrapper was still generated');
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(getWindowsPowerShellPath(), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      helper,
      '-Action',
      action,
      '-CliDir',
      cliDir,
    ], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let errorOutput = '';
    child.stderr.on('data', chunk => { errorOutput += String(chunk); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error(errorOutput.trim() || `PowerShell exited with code ${String(code)}`));
    });
  });
}

function ensureLocalBinInPath(): void {
  if (process.platform === 'win32') return;
  const localBin = join(homedir(), '.local', 'bin');
  if ((process.env.PATH || '').split(delimiter).includes(localBin)) return;
  const shell = process.env.SHELL || '/bin/zsh';
  const profileFile = shell.includes('zsh')
    ? join(homedir(), '.zshrc')
    : shell.includes('fish')
      ? join(homedir(), '.config', 'fish', 'config.fish')
      : join(homedir(), '.bashrc');
  try {
    const existing = existsSync(profileFile) ? readFileSync(profileFile, 'utf8') : '';
    if (existing.includes('.local/bin')) return;
    const line = shell.includes('fish')
      ? '\n# Added by ClawX\nfish_add_path "$HOME/.local/bin"\n'
      : '\n# Added by ClawX\nexport PATH="$HOME/.local/bin:$PATH"\n';
    appendFileSync(profileFile, line);
  } catch (error) {
    logger.warn('Failed to add ~/.local/bin to PATH:', error);
  }
}

export async function installOpenClawCli(): Promise<{ success: boolean; path?: string; error?: string }> {
  const location = getOpenClawRuntimeLocation();
  if (!location) return { success: false, error: 'OpenClaw runtime is not installed.' };
  const target = getOpenClawCliTargetPath();
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (existsSync(target) && !isManagedWrapper(target)) {
      return { success: false, error: `Refusing to replace a user-managed CLI at ${target}` };
    }
    writeFileSync(
      target,
      process.platform === 'win32'
        ? windowsWrapper(location.nodeExecutable, location.entryPath, location.configRoot, location.cacheRoot)
        : posixWrapper(location.nodeExecutable, location.entryPath, location.configRoot, location.cacheRoot),
      { encoding: 'utf8', mode: 0o755 },
    );
    if (process.platform !== 'win32') chmodSync(target, 0o755);
    else await updateWindowsUserPath('add', dirname(target));
    logger.info(`Managed OpenClaw CLI generated at ${target}`);
    return { success: true, path: target };
  } catch (error) {
    logger.error('Failed to install managed OpenClaw CLI:', error);
    return { success: false, error: String(error) };
  }
}

export async function removeManagedOpenClawCli(): Promise<void> {
  const target = getOpenClawCliTargetPath();
  if (!existsSync(target) || !isManagedWrapper(target)) return;
  unlinkSync(target);
  if (process.platform === 'win32') {
    await updateWindowsUserPath('remove', dirname(target)).catch(error => {
      logger.warn('Failed to remove managed OpenClaw CLI directory from PATH:', error);
    });
  }
}

export async function autoInstallCliIfNeeded(notify?: (path: string) => void): Promise<void> {
  if (!app.isPackaged || !getOpenClawRuntimeLocation()) return;
  const result = await installOpenClawCli();
  if (!result.success) throw new Error(result.error ?? 'OpenClaw CLI installation failed');
  if (process.platform !== 'win32') ensureLocalBinInPath();
  if (result.path) notify?.(result.path);
}

function spawnCompletion(args: string[], success: string): void {
  if (!app.isPackaged) return;
  const location = getOpenClawRuntimeLocation();
  if (!location) return;
  const child = spawn(location.nodeExecutable, [location.entryPath, ...args], {
    cwd: location.packageDir,
    env: buildManagedOpenClawEnvironment(location),
    stdio: 'ignore',
    detached: false,
    windowsHide: true,
  });
  child.once('close', code => {
    if (code === 0) logger.info(success);
    else logger.warn(`OpenClaw completion command exited with code ${String(code)}`);
  });
  child.once('error', error => logger.warn('OpenClaw completion command failed:', error));
}

export function generateCompletionCache(): void {
  spawnCompletion(['completion', '--write-state'], 'OpenClaw completion cache generated');
}

export function installCompletionToProfile(): void {
  if (process.platform === 'win32') return;
  spawnCompletion(['completion', '--install', '-y'], 'OpenClaw completion installed to shell profile');
}
