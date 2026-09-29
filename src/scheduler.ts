/**
 * vapor-chamber - scheduled runs.
 *
 * One mechanism behind the features that run a command later or in order:
 * `serialize()` (ordered by a key), the async bus's retry (again, after a wait) and the
 * outbox (in order, when back online). What differs between them is data, not
 * code: the lane a run joins (its ordering key), when it runs, and who
 * receives its result.
 *
 * Lanes: runs sharing a key run one after another, in the order they joined;
 * runs with different keys run concurrently. A run that fails releases its
 * lane like one that succeeds, so a failure cannot deadlock the lane. A lane's
 * entry is reclaimed once it drains, so the map never grows unbounded.
 */

export type Lanes = {
  /** Run `fn` after every earlier run in lane `key` has settled. */
  run<T>(key: string, fn: () => T | Promise<T>): Promise<T>;
};

export function createLanes(): Lanes {
  // Per-key tail of the chain. Stored tails never reject (errors absorbed), so
  // chaining the next run onto them is safe.
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      const run = prev.then(fn);
      const tail = run.then(() => {}, () => {});
      tails.set(key, tail);
      tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
      return run;
    },
  };
}

/**
 * Waits that can be ended early. `sleep(ms, signal?)` resolves `true` when the
 * time is up and `false` when `wakeAll()` (a dispose) or the signal's abort
 * ended it first, so a caller waiting to run again can settle instead of
 * hanging. A wait that ends removes itself.
 */
export type Sleeper = {
  sleep(ms: number, signal?: AbortSignal): Promise<boolean>;
  wakeAll(): void;
};

export function createSleeper(): Sleeper {
  const sleeping = new Set<() => void>();
  return {
    sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        if (signal?.aborted) return resolve(false);
        const end = (due: boolean): void => {
          clearTimeout(timer);
          sleeping.delete(wake);
          signal?.removeEventListener('abort', wake);
          resolve(due);
        };
        const wake = (): void => end(false);
        const timer = setTimeout(end, ms, true);
        sleeping.add(wake);
        signal?.addEventListener('abort', wake);
      });
    },
    wakeAll(): void {
      for (const wake of sleeping) wake();
    },
  };
}
