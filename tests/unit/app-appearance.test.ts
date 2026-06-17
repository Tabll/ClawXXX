import { describe, expect, it } from 'vitest';
import { applyAppAppearance } from '@/lib/app-appearance';

describe('app appearance', () => {
  it('toggles macOS font smoothing class on the root element', () => {
    const root = document.createElement('div');

    applyAppAppearance({ macOSNativeFontSmoothing: true }, root);
    expect(root).toHaveClass('clawx-macos-font-smoothing');

    applyAppAppearance({ macOSNativeFontSmoothing: false }, root);
    expect(root).not.toHaveClass('clawx-macos-font-smoothing');
  });
});
