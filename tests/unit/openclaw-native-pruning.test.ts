// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('September native closure target isolation', () => {
  it('prunes nested Channel dependencies, optional platform packages and embedded PTY/TUI/Bare prebuilds', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-native-pruning-'));
    const keep = [
      'node_modules/@openclaw/fs-safe-linux-arm64-gnu/a.node',
      'node_modules/@trycua/cua-driver-linux-arm64-gnu/a.node',
      'node_modules/@ubjs/node-linux-arm64-gnu/a.node',
      'node_modules/bare-fs/prebuilds/linux-arm64/addon.bare',
      'clawx-plugins/wecom/node_modules/@wecom/cli-linux-arm64/bin/wecom-cli',
      'clawx-plugins/discord/node_modules/@discordjs/voice/node_modules/@snazzah/davey-linux-arm64-gnu/a.node',
    ];
    const remove = [
      'node_modules/@openclaw/fs-safe-linux-arm64-musl/a.node',
      'node_modules/@trycua/cua-driver-darwin-arm64/a.node',
      'node_modules/@ubjs/node-linux-x64-gnu/a.node',
      'node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-arm64/a.node',
      'node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/a.node',
      'node_modules/bare-fs/prebuilds/ios-arm64/addon.bare',
      'node_modules/fsevents/fsevents.node',
      'clawx-plugins/wecom/node_modules/@wecom/cli-darwin-arm64/bin/wecom-cli',
      'clawx-plugins/discord/node_modules/@discordjs/voice/node_modules/@snazzah/davey-linux-x64-gnu/a.node',
      'clawx-plugins/discord/node_modules/@discordjs/voice/node_modules/@snazzah/davey-linux-arm64-musl/a.node',
    ];
    try {
      for (const file of [...keep, ...remove]) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), 'test-only'); }
      execFileSync(process.execPath, [resolve('scripts/kernel-runtime/prune-native-payload.mjs'), '--payload', root, '--platform', 'linux', '--arch', 'arm64']);
      for (const file of keep) expect(existsSync(join(root, file)), file).toBe(true);
      for (const file of remove) expect(existsSync(join(root, file)), file).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
