/** For the tab tests: a listener on a store's channel, and a wait until it carries nothing. Rationale at the end. */

/** Every message on the channel `name`, as a listener that is not a tab reads it, and its close. */
export function listen(name: string): { heard: Array<Record<string, unknown>>; close: () => void } {
  const heard: Array<Record<string, unknown>> = [];
  const ch = new BroadcastChannel(name);
  ch.onmessage = (e) => { heard.push(e.data); };
  return { heard, close: () => ch.close() };
}

/**
 * Waits until `heard` has grown by nothing for 80 ms, after at least 80 ms (a
 * lock grant posts nothing until it lands). Fails after 3 s: tabs that never
 * go quiet are a finding, not a slow run.
 */
export async function quiet(heard: unknown[]): Promise<void> {
  const until = Date.now() + 3000;
  let seen = -1;
  for (;;) {
    if (heard.length === seen) return;
    if (Date.now() > until) throw new Error(`the channel never went quiet (${heard.length} messages)`);
    seen = heard.length;
    await new Promise((r) => setTimeout(r, 80));
  }
}

/** One list of every message on the channels a file's tabs use: `watch` each name, `settle` waits until they carry nothing, `close` ends them. */
export function traffic(): { watch(name: string): void; settle(): Promise<void>; close(): void } {
  const heard: unknown[] = [];
  const open = new Map<string, BroadcastChannel>();
  return {
    watch(name) {
      if (open.has(name)) return;
      const ch = new BroadcastChannel(name);
      ch.onmessage = (e) => { heard.push(e.data); };
      open.set(name, ch);
    },
    settle: () => quiet(heard),
    close() {
      for (const ch of open.values()) ch.close();
      open.clear();
      heard.length = 0;
    },
  };
}

/** How many of `messages` each tab sent, sorted by count. */
export function perTab(messages: Array<Record<string, unknown>>): number[] {
  const by = new Map<unknown, number>();
  for (const m of messages) by.set(m.tab, (by.get(m.tab) ?? 0) + 1);
  return [...by.values()].sort((x, y) => x - y);
}

/*
 * The tabs of a shared store reach one state through a lock grant, the lead's
 * `lead` heard back, an ask and an answer (log 36.F39): more round trips than a
 * fixed sleep can promise under load or coverage. Waiting for the channel to
 * carry nothing waits them out, and a protocol that never settles fails here
 * instead of passing on a lucky sleep.
 */
