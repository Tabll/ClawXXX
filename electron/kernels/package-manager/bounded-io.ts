// A per-verification bound, independent of payload size. Concurrent kernel
// installs have separate pools; never create one promise/stream per file.
export const KERNEL_FILE_IO_CONCURRENCY = 8;

export const KERNEL_TAR_DIRECTORY_CACHE_LIMIT = 256;

// node-tar scans its positive directory cache before/after every file. An
// unbounded cache makes large payloads quadratic, especially on Windows where
// it also normalizes every cached path. Evicting a positive entry only forces
// another filesystem check; it never bypasses tar's path/link reservations.
// Each extraction owns a fresh FIFO cache, including concurrent installs.
export function createKernelTarDirectoryCache(): Map<string, boolean> {
  return new class extends Map<string, boolean> {
    override set(key: string, value: boolean): this {
      if (!this.has(key) && this.size >= KERNEL_TAR_DIRECTORY_CACHE_LIMIT) {
        const oldest = this.keys().next();
        if (!oldest.done) this.delete(oldest.value);
      }
      return super.set(key, value);
    }
  }();
}

export async function forEachKernelFile<T>(
  items: readonly T[],
  operation: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        await operation(items[index]!, index);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  // Workers absorb errors so all outstanding filesystem operations settle
  // before callers quarantine/remove an invalid staging tree.
  await Promise.all(Array.from({ length: Math.min(KERNEL_FILE_IO_CONCURRENCY, items.length) }, worker));
  if (failed) throw failure;
}
