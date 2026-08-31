import { resolve } from 'node:path';

function canonicalNativePath(value: string): string {
  const canonical = resolve(value);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * Compare filesystem paths using the current platform's path and casing rules.
 * Windows can return a different drive-letter case or separator style after
 * realpath/IPC round trips even when both strings identify the same file.
 */
export function nativePathsEqual(actual: unknown, expected: string): boolean {
  return typeof actual === 'string'
    && canonicalNativePath(actual) === canonicalNativePath(expected);
}
