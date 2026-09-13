/** Test-only event barrier. Observes real work; never polls or substitutes it. */
export function createContractSignal<T>(label: string, timeoutMs = 2_000) {
  // Preserve the observer's watchdog and matching cancellation API if a test
  // subsequently controls scheduler timers. Storage/event waits stay real-time.
  const startTimer = setTimeout;
  const cancelTimer = clearTimeout;
  const seen: T[] = [];
  const waiting = new Set<{
    matches(value: T): boolean;
    accept(value: T): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let disposed = false;
  return {
    publish(value: T): void {
      if (disposed) return;
      seen.push(value);
      for (const waiter of waiting) {
        if (!waiter.matches(value)) continue;
        waiting.delete(waiter);
        cancelTimer(waiter.timer);
        waiter.accept(value);
      }
    },
    waitFor(matches: (value: T) => boolean = () => true): Promise<T> {
      if (disposed) return Promise.reject(new Error(`${label}: observer disposed`));
      const index = seen.findIndex(matches);
      if (index >= 0) return Promise.resolve(seen[index]!);
      return new Promise<T>((accept, reject) => {
        const waiter = {
          matches, accept, reject,
          timer: startTimer(() => {
            waiting.delete(waiter);
            reject(new Error(`${label}: no matching event within ${timeoutMs} ms`));
          }, timeoutMs),
        };
        waiting.add(waiter);
      });
    },
    dispose(): void {
      disposed = true;
      for (const waiter of waiting) {
        cancelTimer(waiter.timer);
        waiter.reject(new Error(`${label}: observer disposed`));
      }
      waiting.clear();
    },
  };
}
