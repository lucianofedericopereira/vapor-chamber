/** A storage for an outbox's queue in a test: localStorage's two methods over a Map, its saves readable. */
import type { OutboxRecord } from '../src/outbox';
import type { PersistStorage } from '../src/store-persist';

/** The outbox's default name, the key its queue is saved under. */
export const OUTBOX_KEY = 'vc:outbox';

/**
 * A storage holding `stored` as a queue saved under `key` before the outbox
 * is created. `async` makes both methods answer promises, as IndexedDB's do.
 * `rows()` reads the records saved last, `saves` counts the saves.
 */
export function queueStorage(stored: OutboxRecord[] | null = null, opts: { key?: string; async?: boolean } = {}) {
  const key = opts.key ?? OUTBOX_KEY;
  const items = new Map<string, string>();
  if (stored !== null) items.set(key, JSON.stringify({ records: stored, clears: 0 }));
  const read = (k: string): string | null => items.get(k) ?? null;
  const write = (k: string, v: string): void => { items.set(k, v); out.saves++; };
  const out = {
    saves: 0,
    getItem: opts.async ? async (k: string) => read(k) : read,
    setItem: opts.async ? async (k: string, v: string) => { write(k, v); } : write,
    rows: (): OutboxRecord[] => {
      const raw = items.get(key);
      return raw === undefined ? [] : (JSON.parse(raw) as { records: OutboxRecord[] }).records;
    },
  };
  return out as typeof out & PersistStorage;
}

/** A stored record of a previous session, its tab long closed. */
export const storedRecord = (r: Omit<OutboxRecord, 'tab' | 'queuedAt'> & Partial<Pick<OutboxRecord, 'queuedAt'>>): OutboxRecord =>
  ({ tab: 'closed', queuedAt: '2026-10-04T00:00:00.000Z', ...r });
