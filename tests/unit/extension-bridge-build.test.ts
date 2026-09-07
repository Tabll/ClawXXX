import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('self-contained shared UI build entrypoint', () => {
  it.each([false, true])('generates both bridges before Vite in a clean checkout (missing external package=%s)', (external) => {
    const root = mkdtempSync(join(tmpdir(), 'clawx clean ui '));
    try {
      const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
      mkdirSync(join(root, 'scripts'));
      cpSync(join(process.cwd(), 'scripts/generate-ext-bridge.mjs'), join(root, 'scripts/generate-ext-bridge.mjs'));
      if (external) writeFileSync(join(root, 'clawx-extensions.json'), JSON.stringify({
        extensions: { main: ['@fixture/missing/main'], renderer: ['@fixture/missing/ui'] },
      }));
      // Run the actual package command and generator. This compiler sentinel
      // checks ordering; a separate clean-copy validation runs the real Vite.
      const vite = join(root, 'node_modules/vite/bin/vite.js');
      mkdirSync(dirname(vite), { recursive: true });
      writeFileSync(vite, `const { readFileSync } = require('node:fs');
        const assert = require('node:assert/strict');
        for (const [file, name] of [
          ['electron/extensions/_ext-bridge.generated.ts', 'loadExternalMainExtensions'],
          ['src/extensions/_ext-bridge.generated.ts', 'loadExternalRendererExtensions'],
        ]) assert.match(readFileSync(file, 'utf8'), new RegExp('export function ' + name));
        assert.equal(process.argv[2], 'build');
        console.log('compiler received both generated bridges');
      `);
      expect(existsSync(join(root, 'electron/extensions/_ext-bridge.generated.ts'))).toBe(false);
      expect(existsSync(join(root, 'src/extensions/_ext-bridge.generated.ts'))).toBe(false);
      const output = execSync(packageJson.scripts['build:vite'], {
        cwd: root, encoding: 'utf8', timeout: 15_000, windowsHide: true,
        env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` },
        stdio: 'pipe',
      });
      expect(output).toContain('compiler received both generated bridges');
      expect(output.indexOf('[ext-bridge]')).toBeLessThan(output.indexOf('compiler received'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
