import fs from 'node:fs/promises';

// Windows can briefly retain a mapped executable after both child exit and
// stdio close. Keep directory moves atomic; never copy, chmod or delete around
// a lock. This is a finite OS-lock grace period, not an installation retry.
const WINDOWS_RENAME_DELAYS_MS = [50, 100, 200, 400, 750] as const;

export async function renameRuntimeDirectory(
  source: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY')
        || attempt >= WINDOWS_RENAME_DELAYS_MS.length) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, WINDOWS_RENAME_DELAYS_MS[attempt]));
    }
  }
}
