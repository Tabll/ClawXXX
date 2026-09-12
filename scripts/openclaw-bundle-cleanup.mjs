/** Platform-independent OpenClaw payload cleanup, shared with real closure regressions. */
import fs from 'node:fs';
import path from 'node:path';

function rmSafe(target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    else fs.rmSync(target, { force: true });
    return true;
  } catch { return false; }
}

function cleanupNodeModulesRuntimeJunk(nodeModulesDir) {
  let removedCount = 0;

  const nodeWavDir = path.join(nodeModulesDir, 'node-wav');
  for (const name of ['x.json', 'x.js', 'x.js~', 'file.wav']) {
    if (rmSafe(path.join(nodeWavDir, name))) removedCount++;
  }

  // tree-sitter-bash ships C sources for rebuilding its native addon. Packaged
  // builds use the prebuilt addon/wasm; keep node-types.json because the CJS
  // entry exposes it as optional runtime metadata.
  const treeSitterSrc = path.join(nodeModulesDir, 'tree-sitter-bash', 'src');
  for (const name of ['parser.c', 'scanner.c', 'grammar.json', 'tree_sitter']) {
    if (rmSafe(path.join(treeSitterSrc, name))) removedCount++;
  }

  return removedCount;
}

function cleanupKnownRuntimeJunk(rootDir) {
  let removedCount = 0;
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }

    if (path.basename(dir) === 'node_modules') {
      removedCount += cleanupNodeModulesRuntimeJunk(dir);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      stack.push(path.join(dir, entry.name));
    }
  }

  return removedCount;
}

export function cleanupBundle(outputDir) {
  let removedCount = 0;
  const nm = path.join(outputDir, 'node_modules');
  // OpenClaw 3.x ships built-in extensions under dist/extensions/<ext>/, not
  // extensions/. The previous `path.join(outputDir, 'extensions')` silently
  // resolved to a non-existent directory so the entire walkExt() pass below
  // (which is what cleans .d.ts / .d.mts / source maps inside per-extension
  // node_modules) was a no-op. That left ~28k .d.mts files in the bundle and
  // contributed to the macOS codesign EMFILE blow-up.
  const ext = path.join(outputDir, 'dist', 'extensions');

  // --- openclaw root junk ---
  for (const name of ['CHANGELOG.md', 'README.md']) {
    if (rmSafe(path.join(outputDir, name))) removedCount++;
  }

  // docs/ is kept — contains prompt templates and other runtime-used prompts

  // --- extensions: clean junk from source, aggressively clean nested node_modules ---
  // Extension source (.ts files) are runtime entry points — must be preserved.
  // Only nested node_modules/ inside extensions get the aggressive cleanup.
  if (fs.existsSync(ext)) {
    const JUNK_EXTS = new Set(['.prose', '.ignored_openclaw', '.keep']);
    const NM_REMOVE_DIRS = new Set([
      'test', 'tests', '__tests__', '.github', 'docs', 'examples', 'example',
    ]);
    // .d.mts / .d.cts are TypeScript declaration files for ESM/CJS dual-package
    // builds. They are useless at runtime but show up in huge volumes from
    // typed packages (e.g. typebox), and inflate the per-process file count
    // that codesign opens during macOS signing → EMFILE.
    const NM_REMOVE_FILE_EXTS = [
      '.d.ts', '.d.ts.map',
      '.d.mts', '.d.mts.map',
      '.d.cts', '.d.cts.map',
      '.js.map', '.mjs.map', '.cjs.map', '.ts.map',
      '.markdown',
    ];
    const NM_REMOVE_FILE_NAMES = new Set([
      '.DS_Store', 'README.md', 'CHANGELOG.md', 'LICENSE.md', 'CONTRIBUTING.md',
      'tsconfig.json', '.npmignore', '.eslintrc', '.prettierrc', '.editorconfig',
    ]);

    // .md files inside skills/ directories are runtime content (SKILL.md,
    // block-types.md, etc.) and must NOT be removed.
    const JUNK_MD_NAMES = new Set([
      'README.md', 'CHANGELOG.md', 'LICENSE.md', 'CONTRIBUTING.md',
    ]);

    function walkExt(dir, insideNodeModules, insideSkills) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (insideNodeModules && NM_REMOVE_DIRS.has(entry.name)) {
            if (rmSafe(full)) removedCount++;
          } else {
            walkExt(
              full,
              insideNodeModules || entry.name === 'node_modules',
              insideSkills || entry.name === 'skills',
            );
          }
        } else if (entry.isFile()) {
          if (insideNodeModules) {
            const name = entry.name;
            if (NM_REMOVE_FILE_NAMES.has(name) || NM_REMOVE_FILE_EXTS.some(e => name.endsWith(e))) {
              if (rmSafe(full)) removedCount++;
            }
          } else {
            // Inside skills/ directories, .md files are skill content — keep them.
            // Outside skills/, remove known junk .md files only.
            const isMd = entry.name.endsWith('.md');
            const isJunkMd = isMd && JUNK_MD_NAMES.has(entry.name);
            const isJunkExt = JUNK_EXTS.has(path.extname(entry.name));
            if (isJunkExt || (isMd && !insideSkills && isJunkMd)) {
              if (rmSafe(full)) removedCount++;
            }
          }
        }
      }
    }
    walkExt(ext, false, false);
  }

  // --- node_modules: remove unnecessary file types and directories ---
  if (fs.existsSync(nm)) {
    const REMOVE_DIRS = new Set([
      'test', 'tests', '__tests__', '.github', 'docs', 'examples', 'example',
    ]);
    const REMOVE_FILE_EXTS = [
      '.d.ts', '.d.ts.map',
      '.d.mts', '.d.mts.map',
      '.d.cts', '.d.cts.map',
      '.js.map', '.mjs.map', '.cjs.map', '.ts.map',
      '.markdown',
    ];
    const REMOVE_FILE_NAMES = new Set([
      '.DS_Store', 'README.md', 'CHANGELOG.md', 'LICENSE.md', 'CONTRIBUTING.md',
      'tsconfig.json', '.npmignore', '.eslintrc', '.prettierrc', '.editorconfig',
    ]);

    function walkClean(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (REMOVE_DIRS.has(entry.name)) {
            if (rmSafe(full)) removedCount++;
          } else {
            walkClean(full);
          }
        } else if (entry.isFile()) {
          const name = entry.name;
          if (REMOVE_FILE_NAMES.has(name) || REMOVE_FILE_EXTS.some(e => name.endsWith(e))) {
            if (rmSafe(full)) removedCount++;
          }
        }
      }
    }
    walkClean(nm);
  }

  // Koffi 3.x publishes executable JS under src/koffi, including the nested
  // src/static.cjs loader. Keep this runtime tree intact; only its build-only
  // vendor and documentation directories below are safe to discard. Target
  // native addons are selected separately by prune-native-payload.mjs.
  // --- known large unused subdirectories ---
  const LARGE_REMOVALS = [
    'node_modules/pdfjs-dist/legacy',
    'node_modules/pdfjs-dist/types',
    'node_modules/node-llama-cpp/llama',
    'node_modules/koffi/vendor',
    'node_modules/koffi/doc',
    'dist/extensions/feishu', // Removed in favor of official @larksuite/openclaw-lark plugin
  ];
  for (const rel of LARGE_REMOVALS) {
    if (rmSafe(path.join(outputDir, rel))) removedCount++;
  }

  removedCount += cleanupKnownRuntimeJunk(outputDir);

  return removedCount;
}
