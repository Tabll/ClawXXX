/** Pure filesystem compatibility projection, shared by Main and CI payload probes. */
import path, { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function normalizeFsPathForWindows(filePath: string): string {
  if (process.platform !== 'win32') return filePath;
  if (!filePath) return filePath;
  if (filePath.startsWith('\\\\?\\')) return filePath;

  const windowsPath = filePath.replace(/\//g, '\\');
  if (!path.win32.isAbsolute(windowsPath)) return windowsPath;
  if (windowsPath.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${windowsPath.slice(2)}`;
  }
  return `\\\\?\\${windowsPath}`;
}

function fsPath(filePath: string): string {
  return normalizeFsPathForWindows(filePath);
}

// ── Known plugin-ID corrections ─────────────────────────────────────────────
// Some npm packages ship with an openclaw.plugin.json whose "id" field
// doesn't match the ID the plugin code actually exports.  After copying we
// patch both the manifest AND the compiled JS so the Gateway accepts them.
const MANIFEST_ID_FIXES: Record<string, string> = {
  'wecom-openclaw-plugin': 'wecom',
};

/**
 * After a plugin has been copied to the ClawX-owned extensions directory, fix any
 * known manifest-ID mismatches so the Gateway can load the plugin.
 * Also keeps package.json npm metadata usable by OpenClaw's repair planner.
 */
export function fixupPluginManifest(targetDir: string, logger: { info(message: string): void } = { info: () => undefined }): void {
  // 1. Fix openclaw.plugin.json id
  const manifestPath = join(targetDir, 'openclaw.plugin.json');
  try {
    const raw = readFileSync(fsPath(manifestPath), 'utf-8');
    const manifest = JSON.parse(raw);
    const oldId = manifest.id as string | undefined;
    let modified = false;
    if (oldId && MANIFEST_ID_FIXES[oldId]) {
      const newId = MANIFEST_ID_FIXES[oldId];
      manifest.id = newId;
      modified = true;
      logger.info(`[plugin] Fixed manifest ID: ${oldId} → ${newId}`);
    }

    // OpenClaw 2026.7.1 treats configured channel plugins without a static
    // channelConfigs descriptor as stale/missing and invokes its npm repair
    // flow. The WeCom package has no descriptor upstream, so provide a
    // permissive schema that preserves ClawX's existing channel config fields.
    if (manifest.id === 'wecom' && !manifest.channelConfigs?.wecom) {
      manifest.channelConfigs = {
        ...(manifest.channelConfigs ?? {}),
        wecom: {
          schema: {
            type: 'object',
            additionalProperties: true,
          },
        },
      };
      modified = true;
      logger.info('[plugin] Added WeCom channelConfigs compatibility descriptor');
    }

    if (modified) {
      writeFileSync(fsPath(manifestPath), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    }
  } catch {
    // manifest may not exist yet — ignore
  }

  // 2. Keep package.json package-manager metadata valid
  const pkgPath = join(targetDir, 'package.json');
  try {
    const raw = readFileSync(fsPath(pkgPath), 'utf-8');
    const pkg = JSON.parse(raw);
    let modified = false;

    // Keep the real upstream npm package name/spec even though ClawX patches
    // the effective plugin id. Rewriting these to the non-existent
    // `@wecom/wecom` package makes OpenClaw's repair planner fail before the
    // Gateway starts. Restore metadata previously rewritten by older ClawX
    // compatibility code.
    if (pkg.name === '@wecom/wecom') {
      pkg.name = '@wecom/wecom-openclaw-plugin';
      modified = true;
    }
    const install = pkg.openclaw?.install;
    if (install?.npmSpec === '@wecom/wecom') {
      install.npmSpec = '@wecom/wecom-openclaw-plugin';
      modified = true;
    }

    if (modified) {
      writeFileSync(fsPath(pkgPath), JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
      logger.info(`[plugin] Restored package.json npm metadata in ${targetDir}`);
    }
  } catch {
    // ignore
  }

  // 3. Fix hardcoded plugin IDs in compiled JS entry files.
  //    The Gateway validates that the JS export's `id` matches the manifest.
  patchPluginEntryIds(targetDir, logger);
}

/**
 * Patch the compiled JS entry files so the hardcoded `id` field in the
 * plugin export matches the manifest.  Without this, the Gateway rejects
 * the plugin with "plugin id mismatch".
 */
function patchPluginEntryIds(targetDir: string, logger: { info(message: string): void }): void {
  const pkgPath = join(targetDir, 'package.json');
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(fsPath(pkgPath), 'utf-8'));
  } catch {
    return;
  }

  const entryFiles = [pkg.main, pkg.module].filter(Boolean) as string[];

  for (const entry of entryFiles) {
    const entryPath = join(targetDir, entry);
    if (!existsSync(fsPath(entryPath))) continue;

    let content: string;
    try {
      content = readFileSync(fsPath(entryPath), 'utf-8');
    } catch {
      continue;
    }

    let patched = false;
    for (const [wrongId, correctId] of Object.entries(MANIFEST_ID_FIXES)) {
      // Match patterns like:  id: "wecom-openclaw-plugin"  or  id: 'wecom-openclaw-plugin'
      const escapedWrongId = wrongId.replace(/-/g, '\\-');
      const pattern = new RegExp(`(\\bid\\s*:\\s*)(["'])${escapedWrongId}\\2`, 'g');
      const replaced = content.replace(pattern, `$1$2${correctId}$2`);
      if (replaced !== content) {
        content = replaced;
        patched = true;
        logger.info(`[plugin] Patched plugin ID in ${entry}: "${wrongId}" → "${correctId}"`);
      }
    }

    if (patched) {
      writeFileSync(fsPath(entryPath), content, 'utf-8');
    }
  }
}
