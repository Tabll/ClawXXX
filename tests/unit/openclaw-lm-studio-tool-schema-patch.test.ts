// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const anchoredNonBlankPattern = '^(.|\\n|\\r|\\u2028|\\u2029)*[^\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF](.|\\n|\\r|\\u2028|\\u2029)*$';
const anchoredPatternSource = `pattern: ${JSON.stringify(anchoredNonBlankPattern)}`;
const unanchoredPatternSource = `pattern: ${JSON.stringify('\\S')}`;
const unsupportedAnyCharacterClass = '[^]*';
const oversizedTriggerLimitSource = 'maxLength: 65536';

describe('OpenClaw LM Studio tool-schema patch', () => {
  it('anchors Cron non-blank patterns without narrowing their semantics', () => {
    const pattern = new RegExp(anchoredNonBlankPattern);

    expect(pattern.test('')).toBe(false);
    expect(pattern.test(' \t\n')).toBe(false);
    expect(pattern.test('\u00a0\u3000\ufeff')).toBe(false);
    expect(pattern.test('declaration-key')).toBe(true);
    expect(pattern.test(' human readable name ')).toBe(true);
    expect(pattern.test('line one\nline two')).toBe(true);
    expect(pattern.test('line one\rline two')).toBe(true);
    expect(pattern.test(`line one\u2028line two`)).toBe(true);
    expect(pattern.test('\u00a0value\u3000')).toBe(true);
    expect(anchoredNonBlankPattern).not.toMatch(/\\[sS]/);
    expect(anchoredNonBlankPattern).not.toContain(unsupportedAnyCharacterClass);
  });

  it('keeps the LM Studio compatibility fix in the registered pnpm patch', async () => {
    const patch = await readFile(
      path.join(root, 'patches/openclaw@2026.7.1-2.patch'),
      'utf8',
    );
    const addedAnchoredPatterns = patch
      .split('\n')
      .filter((line) => line.startsWith('+') && line.endsWith(anchoredPatternSource));
    const removedOversizedTriggerLimits = patch
      .split('\n')
      .filter((line) => line.startsWith('-') && line.trimEnd().endsWith(oversizedTriggerLimitSource));

    expect(patch).toContain('diff --git a/dist/cron-tool-C9qaFGtt.js');
    expect(patch).toContain('diff --git a/dist/schema-BuOFpc7K.js');
    expect(addedAnchoredPatterns).toHaveLength(4);
    expect(removedOversizedTriggerLimits).toHaveLength(2);
  });

  it('applies anchored patterns to the installed OpenClaw bundles', async () => {
    const cronToolBundle = await readFile(
      path.join(root, 'node_modules/openclaw/dist/cron-tool-C9qaFGtt.js'),
      'utf8',
    );
    const protocolSchemaBundle = await readFile(
      path.join(root, 'node_modules/openclaw/dist/schema-BuOFpc7K.js'),
      'utf8',
    );

    expect(cronToolBundle).toContain(anchoredPatternSource);
    expect(cronToolBundle).not.toContain(unanchoredPatternSource);
    expect(cronToolBundle).not.toContain(oversizedTriggerLimitSource);
    expect(protocolSchemaBundle.split(anchoredPatternSource)).toHaveLength(4);
    expect(protocolSchemaBundle).not.toContain(unanchoredPatternSource);
    expect(protocolSchemaBundle).not.toContain(oversizedTriggerLimitSource);
  });
});
