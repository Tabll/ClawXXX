/**
 * Base-app afterPack hook.
 *
 * Optional kernel payloads are intentionally absent here. They are produced by
 * kernel-runtime CI and installed under the per-user kernel package root after
 * signature and integrity verification.
 */
const { existsSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { basename, join, relative, sep } = require('node:path');
const { patchNsisExtractTemplate } = require('./patch-nsis-extract.mjs');
const { patchNsisInstallSectionTemplate } = require('./patch-nsis-install-section.mjs');
const { patchNsisUninstallTemplate } = require('./patch-nsis-uninstall.mjs');

function normWin(path) {
  if (process.platform !== 'win32' || path.startsWith('\\\\?\\')) return path;
  return `\\\\?\\${path.replace(/\//g, '\\')}`;
}

function patchUnpackedLruCache(resourcesDir) {
  const unpacked = join(resourcesDir, 'app.asar.unpacked');
  if (!existsSync(unpacked)) return;
  const stack = [unpacked];
  let patchedCount = 0;
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = readdirSync(normWin(directory), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      let directoryEntry = entry.isDirectory();
      if (!directoryEntry) {
        try {
          directoryEntry = statSync(normWin(fullPath)).isDirectory();
        } catch {
          directoryEntry = false;
        }
      }
      if (!directoryEntry) continue;
      if (entry.name !== 'lru-cache') {
        stack.push(fullPath);
        continue;
      }
      const packagePath = join(fullPath, 'package.json');
      if (!existsSync(normWin(packagePath))) continue;
      try {
        const metadata = JSON.parse(readFileSync(normWin(packagePath), 'utf8'));
        if (metadata.type !== 'module') {
          const cjsPath = join(fullPath, metadata.main || 'index.js');
          if (existsSync(normWin(cjsPath))) {
            const source = readFileSync(normWin(cjsPath), 'utf8');
            if (!source.includes('exports.LRUCache')) {
              writeFileSync(
                normWin(cjsPath),
                `${source}\n// ClawX: Node 22 CJS named-export compatibility\nif (typeof module.exports === "function" && !module.exports.LRUCache) module.exports.LRUCache = module.exports;\n`,
                'utf8',
              );
              patchedCount += 1;
            }
          }
        }
        if (typeof metadata.module === 'string') {
          const esmPath = join(fullPath, metadata.module);
          if (existsSync(normWin(esmPath))) {
            const source = readFileSync(normWin(esmPath), 'utf8');
            if (source.includes('export default LRUCache') && !source.includes('export { LRUCache')) {
              writeFileSync(normWin(esmPath), `${source}\nexport { LRUCache }\n`, 'utf8');
              patchedCount += 1;
            }
          }
        }
      } catch (error) {
        console.warn(`[after-pack] Failed to patch lru-cache at ${relative(unpacked, fullPath)}: ${error.message}`);
      }
    }
  }
  if (patchedCount > 0) {
    console.log(`[after-pack] Patched ${patchedCount} unpacked lru-cache entr${patchedCount === 1 ? 'y' : 'ies'}.`);
  }
}

/**
 * A release installer is only the ClawX host. Kernel executables, independent
 * Node runtimes and OpenClaw plugin mirrors belong to signed runtime artifacts.
 * Fail the package job instead of silently shipping an accidental payload.
 */
function assertNoOptionalKernelPayload(resourcesDir) {
  const forbiddenRoots = [
    join(resourcesDir, 'openclaw'),
    join(resourcesDir, 'openclaw-plugins'),
    join(resourcesDir, 'kernel-runtimes'),
    join(resourcesDir, 'node-runtime'),
    join(resourcesDir, 'resources', 'openclaw'),
    join(resourcesDir, 'resources', 'openclaw-plugins'),
    join(resourcesDir, 'resources', 'kernel-runtimes'),
    join(resourcesDir, 'resources', 'node-runtime'),
    join(resourcesDir, 'resources', 'kernels', 'openclaw'),
    join(resourcesDir, 'resources', 'kernels', 'deepseek-harness'),
  ];
  const violations = forbiddenRoots
    .filter(path => existsSync(normWin(path)))
    .map(path => relative(resourcesDir, path));

  const forbiddenFiles = new Set([
    'clawx-openclaw.mjs',
    'clawx-control-bridge.mjs',
    'clawx-dsh-runtime-host.mjs',
  ]);
  const stack = [resourcesDir];
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = readdirSync(normWin(directory), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      const rel = relative(resourcesDir, fullPath);
      // Application code may mention kernel names. Optional executable payloads
      // must never exist outside the signed app.asar boundary.
      if (rel === 'app.asar' || rel.startsWith(`app.asar.unpacked${sep}`)) continue;
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        violations.push(`${rel} (symbolic link)`);
        continue;
      }
      if (!isDirectory && entry.isFile() && forbiddenFiles.has(basename(fullPath))) {
        violations.push(rel);
      }
      if (isDirectory) stack.push(fullPath);
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Base package contains optional kernel payloads:\n${[...new Set(violations)].sort().map(path => ` - ${path}`).join('\n')}`,
    );
  }
  console.log('[after-pack] Verified base package contains no optional kernel runtime or plugin payload.');
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const resourcesDir = platform === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources');

  patchUnpackedLruCache(resourcesDir);
  assertNoOptionalKernelPayload(resourcesDir);
  if (platform === 'win32') {
    const patched = [
      patchNsisExtractTemplate(),
      patchNsisInstallSectionTemplate(),
      patchNsisUninstallTemplate(),
    ];
    if (patched.every(Boolean)) console.log('[after-pack] NSIS install templates ready.');
  }
};

exports.assertNoOptionalKernelPayload = assertNoOptionalKernelPayload;
