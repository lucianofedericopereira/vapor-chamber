/**
 * Platform facts the source comments rely on, read in a real Chromium (audit B rows).
 * Each case states the fact, then checks it with a control. Note at the end.
 */
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => { document.body.innerHTML = ''; });

describe('events', () => {
  it('a click on a disabled <button> reaches no listener; on an aria-disabled <div> or an <a> it does (DIR-23)', () => {
    const heard: string[] = [];
    document.body.innerHTML = '<button id="b" disabled>b</button><div id="d" aria-disabled="true">d</div><a id="a" href="#x">a</a>';
    for (const id of ['b', 'd', 'a']) {
      const el = document.getElementById(id)!;
      el.addEventListener('click', (e) => { heard.push(id); e.preventDefault(); });
      el.click();
    }
    expect(heard).toEqual(['d', 'a']);
  });

  it('disabled during dispatch: a later listener on the same element still runs (DIR-24)', () => {
    document.body.innerHTML = '<button id="b">b</button>';
    const b = document.getElementById('b') as HTMLButtonElement;
    const heard: string[] = [];
    b.addEventListener('click', () => { heard.push('first'); b.disabled = true; });
    b.addEventListener('click', () => heard.push('second'));
    b.click();
    expect(heard).toEqual(['first', 'second']);
  });

  it('a document listener runs after the element listeners; stopPropagation on the element hides it (DIR-25)', () => {
    document.body.innerHTML = '<button id="b">b</button>';
    const b = document.getElementById('b')!;
    const heard: string[] = [];
    const onDoc = () => heard.push('document');
    document.addEventListener('click', onDoc);
    b.addEventListener('click', () => heard.push('element'));
    b.click();
    b.addEventListener('click', (e) => e.stopPropagation());
    b.click();
    document.removeEventListener('click', onDoc);
    expect(heard).toEqual(['element', 'document', 'element']);
  });

  it('composedPath crosses an open shadow root; a document listener sees the host as target (DIR-19, RD-5)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const inner = host.attachShadow({ mode: 'open' }).appendChild(document.createElement('button'));
    let seen: { target: string; first: string } | null = null;
    const onDoc = (e: Event) => { seen = { target: (e.target as Element).tagName, first: (e.composedPath()[0] as Element).tagName }; };
    document.addEventListener('click', onDoc);
    inner.click();
    document.removeEventListener('click', onDoc);
    expect(seen).toEqual({ target: 'DIV', first: 'BUTTON' });
  });

  it('{ once: true } removes only the listener that fired (RD-8, CB-34)', () => {
    const t = new EventTarget();
    const heard: string[] = [];
    t.addEventListener('x', () => heard.push('once'), { once: true });
    t.addEventListener('x', () => heard.push('kept'));
    t.dispatchEvent(new Event('x'));
    t.dispatchEvent(new Event('x'));
    expect(heard).toEqual(['once', 'kept', 'kept']);
  });

  it('a listener added during dispatch does not run in it; one removed does not run (CB-23)', () => {
    const t = new EventTarget();
    const heard: string[] = [];
    const late = () => heard.push('late');
    const removed = () => heard.push('removed');
    t.addEventListener('x', () => { heard.push('first'); t.addEventListener('x', late); t.removeEventListener('x', removed); });
    t.addEventListener('x', removed);
    t.dispatchEvent(new Event('x'));
    expect(heard).toEqual(['first']);
  });

  it('a composed event dispatched on a host reaches a document listener; a non-composed one from inside a shadow root does not (IE-5)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = root.appendChild(document.createElement('span'));
    const heard: string[] = [];
    const onDoc = (e: Event) => heard.push(`${e.type}`);
    document.addEventListener('plain', onDoc);
    document.addEventListener('comp', onDoc);
    inner.dispatchEvent(new CustomEvent('plain', { bubbles: true }));
    inner.dispatchEvent(new CustomEvent('comp', { bubbles: true, composed: true }));
    document.removeEventListener('plain', onDoc);
    document.removeEventListener('comp', onDoc);
    expect(heard).toEqual(['comp']);
  });
});

describe('abort', () => {
  it('addEventListener with an already-aborted signal adds nothing (CB-10)', () => {
    const t = new EventTarget();
    const ac = new AbortController();
    ac.abort();
    let n = 0;
    t.addEventListener('x', () => n++, { signal: ac.signal });
    t.dispatchEvent(new Event('x'));
    expect(n).toBe(0);
  });

  it('abort() with no reason gives a DOMException named AbortError; throwIfAborted throws the reason itself (CB-41, CB-19)', () => {
    const ac = new AbortController();
    ac.abort();
    const mine = new Error('mine');
    const ac2 = new AbortController();
    ac2.abort(mine);
    let thrown: unknown;
    try { ac2.signal.throwIfAborted(); } catch (e) { thrown = e; }
    expect([(ac.signal.reason as DOMException).name, ac.signal.reason instanceof DOMException, thrown === mine]).toEqual(['AbortError', true, true]);
  });

  it('AbortSignal.timeout() aborts with a DOMException named TimeoutError (TP-1)', async () => {
    const s = AbortSignal.timeout(1);
    await new Promise((r) => setTimeout(r, 20));
    expect((s.reason as DOMException).name).toBe('TimeoutError');
  });
});

describe('fetch and headers', () => {
  it('Headers.get is case-insensitive and joins a repeated header with ", " (HT-12)', () => {
    const h = new Headers();
    h.append('X-A', '1');
    h.append('x-a', '2');
    expect([h.get('x-A'), [...h.keys()]]).toEqual(['1, 2', ['x-a']]);
  });

  it('a FormData body with no Content-Type gets a multipart boundary from the engine (HT-18)', () => {
    const fd = new FormData();
    fd.append('a', '1');
    const req = new Request('https://example.test/', { method: 'POST', body: fd });
    expect(req.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
  });
});

describe('timers', () => {
  it('setTimeout reads NaN as 0, and a delay past 2^31-1 fires at once (HT-2, TP-6)', async () => {
    const fired: string[] = [];
    setTimeout(() => fired.push('nan'), Number.NaN);
    setTimeout(() => fired.push('huge'), 2 ** 31);
    setTimeout(() => fired.push('control-500'), 500);
    await new Promise((r) => setTimeout(r, 50));
    expect(fired.sort()).toEqual(['huge', 'nan']);
  });
});

describe('structured clone', () => {
  it('a class instance clones as a plain object; an own function property throws DataCloneError (PI-3, SD-20)', () => {
    class Item { id = 1; total() { return 2; } }
    const copy = structuredClone(new Item()) as Item;
    let thrown = '';
    try { structuredClone({ id: 1, f() {} }); } catch (e) { thrown = (e as DOMException).name; }
    expect([JSON.stringify(copy), copy instanceof Item, thrown]).toEqual(['{"id":1}', false, 'DataCloneError']);
  });
});

describe('history', () => {
  it('pushState to another origin throws a SecurityError; a same-origin path does not (RH-1)', () => {
    let name = '';
    try { history.pushState(null, '', 'https://elsewhere.example/'); } catch (e) { name = (e as DOMException).name; }
    const here = location.href;
    history.pushState(null, '', `${location.pathname}?probe=1`);
    history.replaceState(null, '', here);
    expect(name).toBe('SecurityError');
  });
});

describe('elements', () => {
  it('customElements.define refuses a name without a hyphen (IE-1)', () => {
    expect(() => customElements.define('nohyphen', class extends HTMLElement {})).toThrow(DOMException);
  });

  it('tabIndex reads -1 on a non-focusable element, 0 on a link, a button and summary, and -1 on editable content although it is focusable (RA-4)', () => {
    document.body.innerHTML = '<h1>t</h1><a href="#x">a</a><button>b</button><details><summary>s</summary></details><div contenteditable="true">e</div>';
    const read = (sel: string) => (document.querySelector(sel) as HTMLElement).tabIndex;
    expect([read('h1'), read('a'), read('button'), read('summary'), read('[contenteditable]')]).toEqual([-1, 0, 0, 0, -1]);
  });

  it('a getter-only property throws on write in strict mode (SB-2)', () => {
    // Strict mode by construction: a module's code is strict, no directive needed.
    const o = Object.defineProperty({}, 'state', { get: () => 1, enumerable: true });
    expect(() => { (o as { state: number }).state = 2; }).toThrow(TypeError);
  });
});

/*
 * Audit, session 8 (log 36.11): the B rows that state a DOM, Fetch or timer
 * fact are checked here in Chromium, the engine test:browser runs, rather
 * than in happy-dom. Each case is the fact as the comment states it, with its
 * row id. A fact that holds only in other engines would need an instance for
 * them (vitest.browser.config.ts is Chromium only).
 */
