/** A shared store opened later asks for the current state, so its writes build on it (plan 1.27 item 8). Rationale at the end. */
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { createFastLane } from '../src/fast-lane';
import { createChannel } from '../src/plugins-io';
import { defineChamberStore } from '../src/store';

type Cart = { items: string[] };
const reducers = { add: (s: Cart, item: string) => ({ items: [...s.items, item] }) };

const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

let n = 0;
/** One "tab": its own bus, lane, channel and store, on a shared channel name; `syncs` counts the tab's cart$sync. */
function tab(name: string) {
  const lane = createFastLane();
  const ch = createChannel({ channel: name, lane, events: ['cart$state'] });
  closers.push(() => ch.dispose());
  const bus = createCommandBus();
  let syncs = 0;
  bus.on('cart$sync', () => { syncs++; });
  const cart = defineChamberStore('cart', { state: (): Cart => ({ items: [] }), reducers, share: lane })(bus);
  closers.push(() => cart.$dispose());
  return { cart, syncs: () => syncs };
}

/** A 1.26 tab: the released receive rule, on its own channel. Returns the states it applied. */
function releasedTab(name: string, version: number) {
  const lane = createFastLane();
  const ch = createChannel({ channel: name, lane, events: ['cart$state'] });
  closers.push(() => ch.dispose());
  const me = 'zzzz-old';
  const applied: unknown[] = [];
  lane.on('cart$state', (m: { state: unknown; version: number; tab: string }) => {
    if (m.tab === me) return;
    if (m.version > version || (m.version === version && m.tab > me)) { version = m.version; applied.push(m.state); }
  });
  return applied;
}

/** BroadcastChannel delivers on a later task. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('a tab opened later', () => {
  it('catches up when it opens, and its write builds on the current state', async () => {
    const name = `late-${n++}`;
    const a = tab(name);
    a.cart.add('milk');
    a.cart.add('eggs');
    a.cart.add('tea');
    await settle();
    const b = tab(name);
    await settle();
    expect(b.cart.state.value).toEqual({ items: ['milk', 'eggs', 'tea'] });
    b.cart.add('bread');
    await settle();
    expect(a.cart.state.value).toEqual({ items: ['milk', 'eggs', 'tea', 'bread'] });
    a.cart.add('jam');
    await settle();
    expect(b.cart.state.value).toEqual({ items: ['milk', 'eggs', 'tea', 'bread', 'jam'] });
  });

  it('peers already in step are not written again when a tab opens', async () => {
    const name = `late-${n++}`;
    const a = tab(name);
    const c = tab(name);
    a.cart.add('milk');
    await settle();
    const before = [a.syncs(), c.syncs()];
    tab(name);
    await settle();
    expect([a.syncs(), c.syncs()]).toEqual(before);
  });

  it('a write within one round trip of opening is a concurrent write: every tab ends on one state', async () => {
    const name = `late-${n++}`;
    const a = tab(name);
    a.cart.add('milk');
    a.cart.add('eggs');
    await settle();
    const b = tab(name);
    b.cart.add('bread');
    await settle();
    await settle();
    expect(b.cart.state.value).toEqual(a.cart.state.value);
  });
});

describe('the ask', () => {
  it('a tab that never wrote does not answer, and nothing changes', async () => {
    const name = `late-${n++}`;
    const a = tab(name);
    await settle();
    const b = tab(name);
    await settle();
    expect([a.syncs(), b.syncs()]).toEqual([0, 0]);
    expect(b.cart.state.value).toEqual({ items: [] });
  });

  it('a 1.26 tab at version 0 never applies it', async () => {
    const name = `late-${n++}`;
    const applied = releasedTab(name, 0);
    tab(name);
    await settle();
    expect(applied).toEqual([]);
  });

  it('control: a 1.26 tab still applies a newer write', async () => {
    const name = `late-${n++}`;
    const applied = releasedTab(name, 0);
    tab(name).cart.add('milk');
    await settle();
    expect(applied).toEqual([{ items: ['milk'] }]);
  });
});

/*
 * Each tab numbers its own writes from 0 and applies only a higher number (a
 * tie goes to the higher tab id). A tab opened after another wrote three
 * times started at 0: its first write (version 1) was ignored by the older
 * tab, and the older tab's next write (version 4) replaced it everywhere.
 * The later tab's write was lost (plan item 8, probe P4).
 *
 * Shape: the tab catches up when it opens. It sends one message on the same
 * `<id>$state` event, `{ ask: true, version: -1, tab }`. A peer that has
 * written answers with its current `{ state, version, tab }` and `to`, the
 * asker's id, and the asker applies it by the released rule. A 1.26 tab
 * compares versions only, and -1 is below every version, so no tab, old or
 * new, applies an ask. An answer applies only when strictly newer and only
 * in the tab that asked, so peers in step are not written again.
 *
 * Ordering by time (a clock in `version`, an RFC 3339 `at`) was rejected:
 * `share` sends the whole state, so reordering only picks which tab's data
 * is lost. A write made within one round trip of opening is a concurrent
 * write, the documented last-writer-wins case. Log s35.164.
 */
