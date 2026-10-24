/** A shared store against a scripted lead: each arrangement of the tab protocol set exactly, on the real lock and channel. Rationale at the end. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store/core';
import { shareTabs } from '../src/store-share';
import { history } from '../src/plugins-core';
import { httpTransport } from '../src/transports';
import { quiet } from './tabs-quiet';

type S = { v: string; items: string[] };
const reducers = {
  set: (s: S, v: string) => ({ ...s, v }),
  push: (s: S, x: string) => ({ ...s, items: [...s.items, x] }),
};
const START = (): S => ({ v: '', items: [] });
type Msg = { kind: string; value: any; tab: string; to?: string };

const closers: Array<() => void> = [];
beforeEach(() => { vi.stubGlobal('window', {}); });
afterEach(() => { while (closers.length) closers.pop()!(); vi.unstubAllGlobals(); });

let n = 0;
/** A command as a tab sends it. */
const wire = (action: string, target: string, id: string) => ({ action, target, payload: undefined, id, causationId: undefined, ts: 1 });

/**
 * The lead, scripted: it holds the store's Web Lock (so no store takes it),
 * answers each ask with `state()` while `answering`, and posts what a test
 * tells it to, as the tab `tab`.
 */
async function scriptedLead(name: string, state: () => S) {
  let free!: () => void;
  await new Promise<void>((granted) => {
    void navigator.locks.request(name, () => new Promise<void>((r) => { free = r; granted(); }));
  });
  const ch = new BroadcastChannel(name);
  const heard: Msg[] = [];
  const me = { tab: 'lead-1', answering: true };
  ch.onmessage = (e) => {
    heard.push(e.data);
    if (e.data.kind === 'ask' && me.answering) ch.postMessage({ kind: 'answer', value: state(), tab: me.tab, to: e.data.tab });
  };
  let freed = false;
  const release = (): void => { if (!freed) { freed = true; free(); } };
  closers.push(() => { ch.close(); release(); });
  return {
    heard,
    me,
    post: (kind: string, value: unknown, to?: string) => ch.postMessage({ kind, value, tab: me.tab, ...(to !== undefined ? { to } : {}) }),
    /** As another tab on the channel (a follower), not the lead. */
    as: (tab: string, kind: string, value: unknown) => ch.postMessage({ kind, value, tab }),
    release,
  };
}

/** A store's commands as it posted them, from the scripted lead's ear. */
const sent = (heard: Msg[], kind = 'cmd') => heard.filter((m) => m.kind === kind && m.tab !== 'lead-1' && !m.tab.startsWith('lead-') && !m.tab.startsWith('f-'));

function store(name: string, undo: boolean) {
  const bus = createCommandBus();
  const h = history({ bus });
  const s = defineChamberStore('sc', { state: START, reducers, undo, share: shareTabs(name) })(bus);
  closers.push(() => { s.$dispose(); h.dispose(); });
  return { s, h };
}

for (const undo of [false, true]) {
  describe(`the lead's runs meet this tab's writes (undo ${undo})`, () => {
    it('a write the lead confirmed, then its own command, then one it did not confirm yet: the tab runs the lead\'s arrangement', async () => {
      const name = `script-${n++}`;
      const lead = await scriptedLead(name, START);
      const b = store(name, undo);
      await quiet(lead.heard);
      b.s.push('w1');
      b.s.push('w2');
      await quiet(lead.heard);
      const [w1, w2] = sent(lead.heard).map((m) => m.value.id as string);
      lead.post('cmd', { id: w1 });
      lead.post('cmd', wire('scPush', 'x', 'x1'));
      await quiet(lead.heard);
      expect(b.s.state.value.items).toEqual(['w1', 'x', 'w2']);
      lead.post('cmd', { id: w2 });
      lead.post('cmd', wire('scPush', 'y', 'y1'));
      await quiet(lead.heard);
      expect(b.s.state.value.items).toEqual(['w1', 'x', 'w2', 'y']);
    });

    it("the lead's state under a write it did not run yet: the write runs again over it", async () => {
      const name = `script-${n++}`;
      const lead = await scriptedLead(name, START);
      const b = store(name, undo);
      await quiet(lead.heard);
      b.s.push('w1');
      await quiet(lead.heard);
      lead.post('state', { id: 's1', state: { v: 's', items: ['s'] } });
      await quiet(lead.heard);
      expect(b.s.state.value).toEqual({ v: 's', items: ['s', 'w1'] });
      lead.post('cmd', { id: sent(lead.heard)[0]!.value.id });
      lead.post('cmd', wire('scSet', 't', 't1'));
      await quiet(lead.heard);
      expect(b.s.state.value).toEqual({ v: 't', items: ['s', 'w1'] });
    });

    it("a server's state of this tab's own, not run by the lead yet: the lead's command under it changes nothing", async () => {
      const name = `script-${n++}`;
      const lead = await scriptedLead(name, START);
      const post = vi.fn(async () => ({ ok: true, status: 200, data: { state: 1, stores: { sc: { v: 'server', items: ['server'] } } }, headers: {} }));
      const abus = createAsyncCommandBus({ retry: false, transport: { checkout: httpTransport({ endpoint: '/vc', httpClient: { post } as never }) } });
      const b = defineChamberStore('sc', { state: START, reducers, undo, share: shareTabs(name) })(abus);
      closers.push(() => b.$dispose());
      await quiet(lead.heard);
      await abus.dispatch('checkout', null);
      await b.push('w1');
      await quiet(lead.heard);
      expect(sent(lead.heard, 'state')).toHaveLength(1);
      lead.post('cmd', wire('scPush', 'x', 'x1'));
      await quiet(lead.heard);
      // Under the server's state the lead's command sets nothing: the state, then w1.
      expect(b.state.value).toEqual({ v: 'server', items: ['server', 'w1'] });
    });
  });
}

describe('a new lead', () => {
  it("asks it, takes its answer, and does not run again a write of its own that new lead already ran", async () => {
    const name = `script-${n++}`;
    let answer: S = START();
    const lead = await scriptedLead(name, () => answer);
    const post = vi.fn(async () => ({ ok: true, status: 200, data: { state: 1, stores: { sc: { v: 'server', items: [] } } }, headers: {} }));
    const abus = createAsyncCommandBus({ retry: false, transport: { checkout: httpTransport({ endpoint: '/vc', httpClient: { post } as never }) } });
    const b = defineChamberStore('sc', { state: START, reducers, undo: true, share: shareTabs(name) })(abus);
    closers.push(() => b.$dispose());
    await quiet(lead.heard);
    await abus.dispatch('checkout', null);
    await b.push('w2');
    await quiet(lead.heard);
    const w2 = sent(lead.heard).find((m) => m.value.target === 'w2')!.value.id;
    // A new lead: it ran w2 before it led (posting it on), and answers with that.
    lead.me.answering = false;
    lead.me.tab = 'lead-2';
    lead.post('lead', undefined);
    await quiet(lead.heard);
    const ask = lead.heard.filter((m) => m.kind === 'ask').at(-1)!;
    lead.post('cmd', { id: w2 });
    answer = { v: 'server', items: ['w2'] };
    lead.post('answer', answer, ask.tab);
    await quiet(lead.heard);
    // Its server's state ran again over the answer and crossed again. w2 did not.
    expect(sent(lead.heard).filter((m) => m.value.id === w2)).toHaveLength(1);
    expect(sent(lead.heard, 'state')).toHaveLength(2);
    expect(b.state.value).toEqual({ v: 'server', items: [] });
  });

  it('an undo of a command under the new answer is not run here: the lead\'s state is taken, under this tab\'s writes', async () => {
    const name = `script-${n++}`;
    let answer: S = START();
    const lead = await scriptedLead(name, () => answer);
    const b = store(name, true);
    await quiet(lead.heard);
    b.s.push('w1');
    await quiet(lead.heard);
    const w1 = sent(lead.heard)[0]!.value.id;
    lead.post('cmd', { id: w1 });
    await quiet(lead.heard);
    lead.me.answering = false;
    lead.me.tab = 'lead-2';
    lead.post('lead', undefined);
    await quiet(lead.heard);
    // Undone here while it asks: held, and not run again over the answer, which holds w1.
    b.h.undo();
    expect(b.s.state.value.items).toEqual([]);
    const ask = lead.heard.filter((m) => m.kind === 'ask').at(-1)!;
    answer = { v: '', items: ['w1'] };
    lead.post('answer', answer, ask.tab);
    await quiet(lead.heard);
    expect(b.s.state.value.items).toEqual(['w1']);
    // The lead undoes w1: this tab does not hold it under the answer, so it takes the state.
    lead.post('undone', { id: w1, state: { v: '', items: [] } });
    await quiet(lead.heard);
    expect(b.s.state.value.items).toEqual([]);
    // Again, with a write of this tab's not run yet: the state goes under it.
    b.s.push('w3');
    lead.post('undone', { id: w1, state: { v: '', items: ['z'] } });
    await quiet(lead.heard);
    expect(b.s.state.value.items).toEqual(['z', 'w3']);
  });

  it('a lead that answered nothing yet, many undos of ids it holds no step of: each takes the state, none is kept for ever', async () => {
    const name = `script-${n++}`;
    const lead = await scriptedLead(name, START);
    const b = store(name, true);
    await quiet(lead.heard);
    for (let i = 0; i < 300; i++) lead.post('undone', { id: `u${i}`, state: { v: String(i), items: [] } });
    await quiet(lead.heard);
    expect(b.s.state.value.v).toBe('299');
  });
});

describe('this tab takes the lock', () => {
  it('answers a tab that asked while it asked, follows a tab that never asked, and takes the state of an undo it does not hold', async () => {
    const name = `script-${n++}`;
    let answer: S = START();
    const lead = await scriptedLead(name, () => answer);
    const l = store(name, true);
    await quiet(lead.heard);
    l.s.push('w1');
    await quiet(lead.heard);
    const w1 = sent(lead.heard)[0]!.value.id;
    lead.post('cmd', { id: w1 });
    // Two new leads: the first answers (w1 is now under that answer), the second never does.
    lead.me.tab = 'lead-2';
    answer = { v: '', items: ['w1'] };
    lead.post('lead', undefined);
    await quiet(lead.heard);
    lead.me.answering = false;
    lead.me.tab = 'lead-3';
    lead.post('lead', undefined);
    await quiet(lead.heard);
    // A follower asks this tab while it asks: answered once this tab leads.
    lead.as('f-1', 'ask', undefined);
    await quiet(lead.heard);
    lead.post('bye', undefined);
    lead.release();
    await quiet(lead.heard);
    const answered = lead.heard.filter((m) => m.kind === 'answer' && m.to === 'f-1');
    expect(answered).toHaveLength(1);
    // The follower's undo of w1, which this tab holds only under an answer: its state stands, and goes out.
    lead.as('f-1', 'undone', { id: w1, state: { v: 'f', items: [] } });
    await quiet(lead.heard);
    expect(lead.heard.at(-1)).toMatchObject({ kind: 'state', value: { state: { v: '', items: ['w1'] } } });
    // A follower's command and state; a tab that never asked writes too.
    lead.as('f-1', 'cmd', wire('scPush', 'f', 'f1'));
    lead.as('f-2', 'cmd', wire('scPush', 'g', 'g1'));
    lead.as('f-1', 'state', { id: 'fs', state: { v: 'fs', items: ['fs'] } });
    await quiet(lead.heard);
    expect(l.s.state.value).toEqual({ v: 'fs', items: ['fs'] });
    expect(lead.heard.filter((m) => m.kind === 'state' && m.value.id === 'fs' && !m.tab.startsWith('f-'))).toHaveLength(1);
  });
});

/*
 * Two real tabs settle the protocol in whatever arrangement their tasks fall
 * (tests/store-share-converge.test.ts): a test of a rare arrangement there is
 * a test of luck. Here the lead is a raw channel that holds the store's real
 * Web Lock, so no store takes it, and speaks the lead's side of the protocol:
 * it answers asks, confirms a write by its id, posts its own commands and
 * states, says it is a new lead, and stands in for followers. Each test sets
 * one arrangement the code has a branch for, and checks the store's state and
 * what it sends against it (log 36.F39).
 */
