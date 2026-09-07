// A per-verification bound, independent of payload size. Concurrent kernel
// installs have separate pools; never create one promise/stream per file.
export const KERNEL_FILE_IO_CONCURRENCY = 8;

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
