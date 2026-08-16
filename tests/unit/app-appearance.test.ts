import { describe, expect, it } from 'vitest';
import {
  applyAppAppearance,
  normalizeAppFontFamily,
  normalizeThemeColor,
} from '@/lib/app-appearance';

describe('app appearance', () => {
  it('normalizes theme colors and sanitizes font stacks', () => {
    expect(normalizeThemeColor('0f766e')).toBe('#0f766e');
    expect(normalizeThemeColor('#abc')).toBe('#aabbcc');
    expect(normalizeThemeColor('not-a-color')).toBe('#111111');
    expect(normalizeAppFontFamily('Arial, sans-serif, url(evil)')).toBe('"Arial", sans-serif, "urlevil"');
  });

  it('applies accent, font, and macOS smoothing preferences', () => {
    const root = document.createElement('div');

    applyAppAppearance({
      appFontFamily: 'Arial',
      macOSNativeFontSmoothing: true,
      themeColor: '#0f766e',
    }, root);

    expect(root).toHaveClass('clawx-macos-font-smoothing');
    expect(root.style.getPropertyValue('--app-font-family')).toContain('"Arial"');
    expect(root.style.getPropertyValue('--appearance-primary')).toContain('175');

    applyAppAppearance({ macOSNativeFontSmoothing: false }, root);
    expect(root).not.toHaveClass('clawx-macos-font-smoothing');
  });
});
