/** Minimal OS launch context; never inherit provider secrets or user data roots. */
export function pickKernelNodeElectronHostEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    'PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT',
    // xvfb-run authenticates DISPLAY using a separate authority file. The
    // isolated HOME below must not change where Electron finds that file.
    'DISPLAY', 'XAUTHORITY', 'ELECTRON_DISABLE_SANDBOX', 'LANG',
  ]) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}
