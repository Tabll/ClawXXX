export const DEFAULT_THEME_COLOR = '#111111';

const SYSTEM_FONT_STACK = [
  '-apple-system',
  'BlinkMacSystemFont',
  '"Segoe UI"',
  'Roboto',
  '"Helvetica Neue"',
  'Arial',
  '"Noto Sans"',
  'sans-serif',
  '"Apple Color Emoji"',
  '"Segoe UI Emoji"',
  '"Segoe UI Symbol"',
  '"Noto Color Emoji"',
].join(', ');

const GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

type AppearanceSettings = {
  appFontFamily?: string;
  themeColor?: string;
  macOSNativeFontSmoothing?: boolean;
};

function expandShortHex(value: string): string {
  return `#${value.slice(1).split('').map((char) => char + char).join('')}`;
}

export function normalizeThemeColor(value?: string): string {
  const trimmed = value?.trim().toLowerCase() ?? '';
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;

  if (/^#[0-9a-f]{3}$/.test(withHash)) {
    return expandShortHex(withHash);
  }

  if (/^#[0-9a-f]{6}$/.test(withHash)) {
    return withHash;
  }

  return DEFAULT_THEME_COLOR;
}

function sanitizeFontFamilyPart(value: string): string | null {
  const unquoted = value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/[^a-zA-Z0-9 _.-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!unquoted) return null;
  if (GENERIC_FONT_FAMILIES.has(unquoted.toLowerCase())) return unquoted.toLowerCase();
  return `"${unquoted.replace(/"/g, '\\"')}"`;
}

export function normalizeAppFontFamily(value?: string): string {
  return (value ?? '')
    .split(',')
    .map(sanitizeFontFamilyPart)
    .filter((part): part is string => Boolean(part))
    .slice(0, 8)
    .join(', ');
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }): {
  h: number;
  s: number;
  l: number;
} {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l: lightness * 100 };
  }

  const delta = max - min;
  const saturation = lightness > 0.5
    ? delta / (2 - max - min)
    : delta / (max + min);
  let hue: number;

  if (max === red) {
    hue = (green - blue) / delta + (green < blue ? 6 : 0);
  } else if (max === green) {
    hue = (blue - red) / delta + 2;
  } else {
    hue = (red - green) / delta + 4;
  }

  return {
    h: hue * 60,
    s: saturation * 100,
    l: lightness * 100,
  };
}

function hslTriplet(hsl: { h: number; s: number; l: number }): string {
  return `${Math.round(hsl.h)} ${Math.round(hsl.s)}% ${Math.round(hsl.l)}%`;
}

function deriveHoverHsl(hsl: { h: number; s: number; l: number }): string {
  const nextLightness = hsl.l > 55
    ? Math.max(24, hsl.l - 7)
    : Math.min(72, hsl.l + 7);
  return hslTriplet({ ...hsl, l: nextLightness });
}

function deriveDarkPrimaryHsl(hsl: { h: number; s: number; l: number }): { h: number; s: number; l: number } {
  if (hsl.l < 28) {
    return {
      ...hsl,
      s: hsl.s < 8 ? hsl.s : Math.min(82, hsl.s),
      l: hsl.s < 8 ? 86 : 62,
    };
  }

  if (hsl.l > 78) {
    return { ...hsl, l: 72 };
  }

  return { ...hsl, l: Math.max(56, hsl.l) };
}

function foregroundForHsl(hsl: { l: number }): string {
  return hsl.l >= 68 ? '0 0% 7%' : '0 0% 98%';
}

export function applyAppAppearance(
  { appFontFamily, macOSNativeFontSmoothing, themeColor }: AppearanceSettings,
  root: HTMLElement = document.documentElement,
): void {
  const normalizedFont = normalizeAppFontFamily(appFontFamily);
  const normalizedColor = normalizeThemeColor(themeColor);
  const hsl = rgbToHsl(hexToRgb(normalizedColor));
  const darkHsl = deriveDarkPrimaryHsl(hsl);

  root.style.setProperty(
    '--app-font-family',
    normalizedFont ? `${normalizedFont}, ${SYSTEM_FONT_STACK}` : SYSTEM_FONT_STACK,
  );
  root.style.setProperty('--appearance-primary', hslTriplet(hsl));
  root.style.setProperty('--appearance-ring', hslTriplet(hsl));
  root.style.setProperty('--appearance-brand', hslTriplet(hsl));
  root.style.setProperty('--appearance-brand-hover', deriveHoverHsl(hsl));
  root.style.setProperty('--appearance-primary-foreground', foregroundForHsl(hsl));
  root.style.setProperty('--appearance-primary-dark', hslTriplet(darkHsl));
  root.style.setProperty('--appearance-ring-dark', hslTriplet(darkHsl));
  root.style.setProperty('--appearance-brand-dark', hslTriplet(darkHsl));
  root.style.setProperty('--appearance-brand-hover-dark', deriveHoverHsl(darkHsl));
  root.style.setProperty('--appearance-primary-foreground-dark', foregroundForHsl(darkHsl));
  root.classList.toggle('clawx-macos-font-smoothing', Boolean(macOSNativeFontSmoothing));
}
