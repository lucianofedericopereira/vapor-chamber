/**
 * vapor-chamber - a store across tabs: `shareTabs`, the value of its `share`.
 *
 * `defineChamberStore(id, { ..., share: shareTabs() })`. Each write crosses as
 * the command it came from, with its `meta.id`. One tab runs every tab's
 * command and posts it on: the tab the browser grants the store's Web Lock
 * (the lead). Every other tab runs only what the lead posts, so every tab
 * runs the same commands over the same states and ends on one state. A write
 * still runs at once in its own tab. When the lead's command meets one of this
 * tab's it has not run yet, this tab's run again over it (`rebase`), with the
 * store's own `apply`, `undo` and `put`. The receiving tab writes with no
 * dispatch, so no plugin, listener, transport or reaction runs it twice, and
 * its history records the same command. An undo crosses as the id of the
 * command it reverses. A tab that opens asks, and the lead answers. A tab with
 * no other tab open sends no write. A store without `share` carries none of
 * this (src/store-base.ts, `out`). docs/store.md, Across tabs;
 * tests/store-share-converge.test.ts, tests/store-propagate-undo.test.ts.
 */
import { DEV } from './dev';
import { _report } from './report';

/** @internal A command as it crosses: what a tab needs to apply it, and its id. */
export type WireCommand = { action: string; target: unknown; payload: unknown; id: string; causationId: string | undefined; ts: number };

/** @internal An undo as it crosses: the id of the command it reverses, and the state it reached, for a tab that does not hold that command. */
export type WireUndo<S> = { id: string; state: S };

/** @internal A state set outside the reducers as it crosses, with an id its own tab knows it by when the lead posts it on. */
export type WireState<S> = { id: string; state: S };

/** @internal What a store sends: a command it ran, an undo, or a state set outside its reducers. */
export type TabSend<S> = (kind: 'cmd' | 'undone' | 'state', value: WireCommand | WireUndo<S> | S) => void;

/** @internal What the store gives its tabs. */
export type TabHost<S> = {
  id: string;
  cell: { readonly value: S };
  /** Lands an own write `coalesce` still holds, so an answer carries it. */
  land: () => void;
  /** Sets what each write calls: the send, or null while no other tab is there. */
  open: (send: TabSend<S> | null) => void;
  /** Runs another tab's command with no dispatch. `again`: one this tab already ran, so its history is not told. `under`: see TabHearer. */
  apply: (cmd: WireCommand, again: boolean, under?: readonly string[]) => void;
  /** Undoes the command with this id, as another tab did, or takes its state when this tab does not hold it. */
  undo: (undo: WireUndo<S>, again: boolean) => void;
  /** Writes a state another tab sent. */
  put: (state: S) => void;
  /** The store keeps a ring of steps (`undo` or `optimistic`), so a write can be undone and run again. */
  ring: boolean;
  /** Tells this bus's histories: here, that the state moved, so they read their top again. */
  hear: (kind: 'moved') => void;
  /** Resolves once the store's saved state is read: null when there was none to wait for. */
  ready: Promise<void> | null;
};

/** The value of a store's `share`, made by `shareTabs`: null where there are no tabs. `ready`: the store's `$ready`. */
export type StoreShare<S> = (host: TabHost<S>) => { dispose: () => void; ready: Promise<void> } | null;

/**
 * @internal Whether this realm has tabs to share with: a page or a worker
 * with `BroadcastChannel`. Node, Deno and Bun define BroadcastChannel too: on
 * a server, two requests' stores of one id shared a channel, and each wrote
 * the other's state. The one reader for `shareTabs` and the outbox.
 * tests/store-share.test.ts.
 */
export function _hasTabs(): boolean {
  return typeof BroadcastChannel !== 'undefined'
    && (typeof window !== 'undefined' || typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined');
}

/** One message on a store's channel. `to` on an answer only. */
type TabMessage<S> = { kind: 'ask' | 'answer' | 'cmd' | 'undone' | 'state' | 'bye' | 'lead'; value: unknown; tab: string; to?: string };

/** The Web Locks a page has: `request` with a signal, as the outbox reads it. */
type Locks = { request(name: string, options: { signal: AbortSignal }, fn: () => Promise<void>): Promise<unknown> };

/** How many writes a tab that asked holds unanswered. */
const KEPT = 256;


const rid = (): string => Math.random().toString(36).slice(2);

/** A command, not a state: only a command has an action. */
const isCmd = (v: WireCommand | WireState<unknown>): v is WireCommand => Object.hasOwn(v, 'action');

/**
 * shareTabs - propagate a store across the tabs of one origin, the value of
 * its `share` option: one `BroadcastChannel` and one Web Lock per store, both
 * named `vc:store:<id>` unless `name` is given. The tab holding the lock runs
 * every tab's command and posts it on, and the others follow it. A tab that
 * opens asks for the state and takes the lead's answer. Outside a page or a
 * worker (a server), without `BroadcastChannel` or without Web Locks, nothing
 * opens: without the lock, tabs could end on two states, so development warns.
 *
 * @example
 * defineChamberStore('cart', { state, reducers, share: shareTabs() });
 */
export function shareTabs<S>(name?: string): StoreShare<S> {
  return (host) => {
    if (!_hasTabs()) return null;
    const { id } = host;
    const found = typeof navigator !== 'undefined' ? (navigator as { locks?: Locks | null }).locks : undefined;
    if (found == null || typeof found.request !== 'function') {
      if (DEV) _report('warn', 'store:missing:locks', `Store "${id}": this page has no Web Locks, so the store is not shared across tabs`, undefined, { store: id });
      return null;
    }
    const locks = found;
    const key = name ?? `vc:store:${id}`;
    const channel = new BroadcastChannel(key);
    const tab = rid();
    // The tab holding the lock, whose runs are the state: this tab's own id
    // when it holds it, null while no lead is known.
    let lead: string | null = null;
    // Lead only: the tabs that asked it, left by their `bye`. While asking:
    // the tabs that asked this one, answered if the lock comes here.
    const peers = new Set<string>();
    // This tab's writes the lead has not posted on yet, each as it crossed.
    // The lead posts one tab's writes as that tab posted them, so the one it
    // posts on is the one at `head`. A confirmed write moves `head`, and the
    // slots before it are cut only where a rebase reads them: cutting each
    // from the front copied the array, quadratic in a burst (log 36.F39).
    let mine: Array<WireCommand | WireState<S>> = [];
    let head = 0;
    // Without a ring: the state the lead's runs reached when no write of this
    // tab's was unconfirmed, and this tab's writes the lead ran since. A
    // rebase starts from them, so a write reads no state (log 36.F39).
    let base: S = host.cell.value;
    let folded: Array<WireCommand | WireState<S>> = [];
    // The ids of the commands this tab ran, KEPT at most: a ring, one slot
    // written per command and nothing hashed, as a write pays it. At the
    // lead's answer they become `stale`: a command under the answer is not
    // one the other tabs hold where this tab does, so its undo is taken as
    // the lead's state, never run here. A Set written per command cost a
    // write about 50 ns (log 36.F39). `undid`: the ids this tab undid.
    const ids: string[] = new Array(KEPT).fill('');
    let at = 0;
    let stale: Set<string> | null = null;
    let undid = new Set<string>();
    // While asking: this tab's own writes, run again over the answer. Null
    // once answered or leading, or once KEPT writes went unanswered.
    let held: Array<{ kind: 'cmd' | 'undone' | 'state'; value: unknown }> | null = [];
    // From the grant until this tab hears its own `lead`: other tabs'
    // messages, run once it leads. Null otherwise.
    let waiting: Array<TabMessage<S>> | null = null;
    let probe: BroadcastChannel | null = null;
    // Hidden by `pagehide`: the page may sit in the back-forward cache.
    let away = false;
    let release: (() => void) | null = null;
    let abort: AbortController | null = null;
    // The store holds its tabs' state once this tab leads or took the lead's
    // answer. Disposed before either, it resolves too, so no wait hangs.
    let settle!: () => void;
    const settled = new Promise<void>((r) => { settle = r; });
    const post = (m: TabMessage<S>): void => {
      try {
        channel.postMessage(m);
      } catch (e) {
        // A command the structured clone cannot copy (a function, a DOM node)
        // stays in this tab; the local write stands.
        if (DEV) _report('warn', 'store:invalid:clone', `Store "${id}": a change did not cross to the other tabs: it is not structured-cloneable`, e, { store: id });
      }
    };
    const ran = (cmdId: string): void => {
      ids[at] = cmdId;
      at = (at + 1) & (KEPT - 1);
      // A redo runs an undone command again.
      if (undid.size !== 0) undid.delete(cmdId);
    };
    const unran = (cmdId: string): void => {
      if (undid.add(cmdId).size > KEPT) undid = new Set([cmdId]);
    };
    const holds = (cmdId: string): boolean => stale === null || !stale.has(cmdId);
    const send: TabSend<S> = (kind, raw) => {
      const value = kind === 'state' ? { id: rid(), state: raw as S } : raw;
      if (held !== null) {
        // KEPT writes and no answer: no tab is there. Holding stops. A tab
        // that asks, or the lock, opens it again.
        if (held.push({ kind, value }) > KEPT) {
          held = null;
          host.open(null);
        }
        return;
      }
      if (kind === 'cmd') ran((value as WireCommand).id);
      else if (kind === 'undone') unran((value as WireUndo<S>).id);
      post({ kind, value, tab });
      if (lead !== tab && kind !== 'undone') mine.push(value as WireCommand | WireState<S>);
    };
    const now = (): S => {
      host.land();
      return host.cell.value;
    };
    const drop = (): void => {
      mine = [];
      head = 0;
    };
    // The unconfirmed writes, the confirmed ones cut first.
    const live = (): Array<WireCommand | WireState<S>> => {
      if (head !== 0) {
        mine.splice(0, head);
        head = 0;
      }
      return mine;
    };
    const redo = (v: WireCommand | WireState<S>): void => {
      if (isCmd(v)) host.apply(v, true);
      else host.put(v.state);
    };
    // The lead ran its command or state under this tab's unconfirmed writes.
    // With a ring they are undone here, the lead's runs, and they run again,
    // so the ring holds the lead's arrangement and an undo by id stays true.
    // Its history hears the lead's command under this tab's writes too
    // (`under`), so every tab's history is the same (log 36.F40). A state
    // among this tab's writes sets the state whatever ran under it, so the
    // lead's step is not run. Without a ring, the state from `base`.
    const rebase = (value: WireCommand | S, state: boolean): void => {
      const list = live();
      if (host.ring) {
        for (let i = 0; i < list.length; i++) if (!isCmd(list[i]!)) return;
        for (let i = list.length - 1; i >= 0; i--) host.undo({ id: list[i]!.id, state: host.cell.value }, true);
        if (state) host.put(value as S);
        else {
          host.apply(value as WireCommand, false, list.map((v) => v.id));
          ran((value as WireCommand).id);
        }
        for (let i = 0; i < list.length; i++) host.apply(list[i] as WireCommand, true);
        // The histories heard the lead's command while this tab's ran under
        // it: they read their top again now that the tab's run over it.
        host.hear('moved');
        return;
      }
      host.put(base);
      for (let i = 0; i < folded.length; i++) redo(folded[i]!);
      if (state) host.put(value as S);
      else host.apply(value as WireCommand, false, list.map((v) => v.id));
      base = now();
      folded = [];
      for (let i = 0; i < list.length; i++) redo(list[i]!);
    };
    // Another tab's undo, the lead's: run here when this tab holds that
    // command, else the state it reached, under this tab's unconfirmed writes.
    const undoAt = (u: WireUndo<S>): void => {
      if (!holds(u.id)) {
        if (head === mine.length) {
          host.put(u.state);
          base = u.state;
        } else rebase(u.state, true);
        return;
      }
      if (undid.has(u.id)) return;
      host.undo(u, false);
      unran(u.id);
    };
    const ask = (): void => {
      if (held === null) held = [];
      host.open(send);
      post({ kind: 'ask', value: undefined, tab });
    };
    const answer = (to: string): void => {
      host.land();
      post({ kind: 'answer', value: host.cell.value, tab, to });
    };
    // This tab now leads. Its writes stand: they are the state.
    const rule = (): void => {
      probe?.close();
      probe = null;
      lead = tab;
      drop();
      held = null;
      host.open(peers.size !== 0 ? send : null);
      for (const p of peers) answer(p);
      const w = waiting as Array<TabMessage<S>>;
      waiting = null;
      for (let i = 0; i < w.length; i++) hear(w[i]!);
      settle();
    };
    // The grant. Messages the old lead posted before it left were queued to
    // this tab before its `lead` is: one sender's posts reach a tab as posted,
    // and tasks of one source share one queue (HTML, BroadcastChannel
    // postMessage, step 9). So this tab leads once it hears its own `lead` on
    // a second channel of the name, after every one of them ran here. That
    // channel opens and the `lead` goes out in one task: a post is queued to
    // the channels open when it is made, so the second channel's first
    // message is this tab's own `lead`, and it closes there (`rule`).
    const granted = (): void => {
      waiting = [];
      probe = new BroadcastChannel(key);
      probe.onmessage = rule;
      post({ kind: 'lead', value: undefined, tab });
    };
    const request = (): void => {
      const ctl = new AbortController();
      abort = ctl;
      locks.request(key, { signal: ctl.signal }, () => new Promise<void>((r) => {
        release = r;
        granted();
      })).then(undefined, () => {});
    };
    const free = (): void => {
      abort?.abort();
      abort = null;
      release?.();
      release = null;
      probe?.close();
      probe = null;
      waiting = null;
    };
    const hear = (m: TabMessage<S>): void => {
      if (away) return;
      if (waiting !== null && m.tab !== lead) {
        waiting.push(m);
        return;
      }
      if (m.kind === 'bye') {
        if (m.tab === lead) lead = null;
        else if (peers.delete(m.tab) && lead === tab && peers.size === 0) host.open(null);
        return;
      }
      if (m.kind === 'lead') {
        // Another tab took the lock: this tab asks it, and its own writes the
        // old lead did not post on run again over the answer.
        lead = m.tab;
        peers.clear();
        if (held === null) {
          const list = live();
          held = list.map((v) => ({ kind: isCmd(v) ? 'cmd' as const : 'state' as const, value: v }));
          drop();
        }
        ask();
        return;
      }
      if (m.kind === 'ask') {
        if (lead === tab) {
          if (peers.size === 0) host.open(send);
          peers.add(m.tab);
          answer(m.tab);
        } else if (held !== null) peers.add(m.tab);
        return;
      }
      if (m.kind === 'answer') {
        if (m.to !== tab || held === null) return;
        // The lead's state after all it posted before the answer, so nothing
        // of it held here runs again. This tab's own writes run over it and
        // cross. What this tab held under it is no longer one of the other
        // tabs' commands here (`stale`).
        const kept = held;
        held = null;
        lead = m.tab;
        peers.clear();
        stale = new Set(ids);
        stale.delete('');
        undid = new Set();
        host.put(m.value as S);
        base = m.value as S;
        folded = [];
        for (let i = 0; i < kept.length; i++) {
          const h = kept[i]!;
          if (h.kind === 'undone') {
            const u = h.value as WireUndo<S>;
            if (holds(u.id)) {
              host.undo(u, true);
              unran(u.id);
            }
          } else {
            redo(h.value as WireCommand | WireState<S>);
            if (h.kind === 'cmd') ran((h.value as WireCommand).id);
            mine.push(h.value as WireCommand | WireState<S>);
          }
          post({ kind: h.kind, value: h.value, tab });
        }
        settle();
        return;
      }
      // Asking: what the lead posted before its answer is in it, and the
      // others' writes reach this tab through the lead. A write of this
      // tab's that a new lead ran (it reached that tab before it led) is in
      // the answer too, so it does not run again over it.
      if (held !== null) {
        if (m.tab === lead && m.kind !== 'undone') {
          const ranId = (m.value as { id: string }).id;
          for (let i = 0; i < held.length; i++) {
            if (held[i]!.kind !== 'undone' && (held[i]!.value as { id: string }).id === ranId) {
              held.splice(i, 1);
              break;
            }
          }
        }
        return;
      }
      if (lead === tab) {
        // Another tab's write: run here, then posted on as the lead's. With
        // that tab the only other one, it needs only the id back.
        if (!peers.has(m.tab)) {
          if (peers.size === 0) host.open(send);
          peers.add(m.tab);
        }
        if (m.kind === 'undone') {
          const u = m.value as WireUndo<S>;
          if (!holds(u.id)) {
            // This tab does not hold that command: its state stands, and the
            // other tabs take it.
            post({ kind: 'state', value: { id: rid(), state: host.cell.value }, tab });
            return;
          }
          if (!undid.has(u.id)) {
            host.undo(u, false);
            unran(u.id);
          }
          post({ kind: 'undone', value: { id: u.id, state: host.cell.value }, tab });
          return;
        }
        const v = m.value as WireCommand | WireState<S>;
        if (m.kind === 'cmd') {
          host.apply(v as WireCommand, false);
          ran(v.id);
        } else host.put((v as WireState<S>).state);
        post({ kind: m.kind, value: peers.size === 1 ? { id: v.id } : v, tab });
        return;
      }
      if (m.tab !== lead) return;
      if (m.kind === 'undone') {
        undoAt(m.value as WireUndo<S>);
        return;
      }
      const w = m.value as WireCommand | WireState<S>;
      if (head !== mine.length && mine[head]!.id === w.id) {
        const done = mine[head]!;
        head++;
        if (head === mine.length) {
          drop();
          base = now();
          folded = [];
        } else folded.push(done);
        return;
      }
      if (head !== mine.length) rebase(m.kind === 'cmd' ? (w as WireCommand) : (w as WireState<S>).state, m.kind === 'state');
      else {
        if (m.kind === 'cmd') {
          host.apply(w as WireCommand, false);
          ran(w.id);
        } else host.put((w as WireState<S>).state);
        base = now();
      }
    };
    // A channel never hears its own posts (HTML, BroadcastChannel
    // postMessage, step 7: "Remove source from destinations"), so every
    // message is another tab's.
    channel.onmessage = (event: MessageEvent<TabMessage<S>>) => { hear(event.data); };
    // A tab that leaves says so and frees the lock, and asks again when the
    // page comes back from the back-forward cache.
    const hide = (): void => {
      post({ kind: 'bye', value: undefined, tab });
      away = true;
      free();
      lead = null;
      peers.clear();
      drop();
      host.open(null);
    };
    const show = (e: { persisted?: boolean }): void => {
      if (!e.persisted) return;
      away = false;
      request();
      ask();
    };
    const page = typeof addEventListener === 'function';
    if (page) {
      addEventListener('pagehide', hide);
      addEventListener('pageshow', show);
    }
    request();
    ask();
    return {
      dispose() {
        if (page) {
          removeEventListener('pagehide', hide);
          removeEventListener('pageshow', show);
        }
        free();
        channel.close();
        settle();
      },
      ready: host.ready === null ? settled : host.ready.then(() => settled),
    };
  };
}
/** @internal What a state half gives `_shareStates`: its id, its state and its `put`. */
export type ShareHost<S> = {
  id: string;
  cell: { readonly value: S };
  /** Lands an own write `coalesce` still holds. */
  land: () => void;
  /** Writes a state another tab sent: the owner merges it. */
  put: (state: S) => void;
};

/** @internal What a state half does with one opened state sharing. */
export type ShareHooks<S> = {
  /** On the half's watcher: sends the state a write reached. */
  send: (next: S) => void;
  dispose: () => void;
};

/** @internal A state half's sharing by whole states, for a state whose `put` merges. */
export type StateShare<S> = (host: ShareHost<S>) => ShareHooks<S> | null;

/** One message of a state sharing: a state, or a tab's ask when it opens. */
type StateMessage<S> = { state: S; tab: string; to?: string } | { ask: true; tab: string };

/**
 * @internal A state half shared by whole states (the outbox's queue): each
 * received state goes to `put`, which merges it, each tab the authority for
 * its own records, so nothing is weighed and no tab's change is dropped. A
 * tab that opens asks, and a tab that has written answers it alone. A
 * received state is not sent back. tests/outbox-tabs.test.ts.
 */
export function _shareStates<S>(name: string): StateShare<S> {
  return ({ id, cell, land, put }) => {
    if (!_hasTabs()) return null;
    const channel = new BroadcastChannel(name);
    const tab = Math.random().toString(36).slice(2);
    let wrote = false;
    // The state the tabs agreed on, sent or applied: a write that reaches it
    // is not sent, so an applied state never goes back.
    let shared: unknown;
    const post = (message: StateMessage<S>): void => {
      try {
        channel.postMessage(message);
      } catch (e) {
        if (DEV) _report('warn', 'store:invalid:clone', `Store "${id}": its state did not cross to the other tabs: it is not structured-cloneable`, e, { store: id });
      }
    };
    channel.onmessage = (event: MessageEvent<StateMessage<S>>) => {
      const m = event.data;
      if ('ask' in m) {
        if (wrote) post({ state: cell.value, tab, to: m.tab });
        return;
      }
      if (m.to !== undefined && m.to !== tab) return;
      land();
      shared = m.state;
      put(m.state);
    };
    post({ ask: true, tab });
    return {
      send(next) {
        if (next === shared) return;
        shared = next;
        wrote = true;
        post({ state: next, tab });
      },
      dispose() {
        channel.close();
      },
    };
  };
}
