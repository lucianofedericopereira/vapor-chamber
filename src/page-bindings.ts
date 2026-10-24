/**
 * vapor-chamber - display bindings on plain HTML, `bindDisplay`.
 *
 * `data-vc-text`, `data-vc-show` and `data-vc-each` follow a store's field
 * events (`$onField`); `data-vc-pending` follows the bus's command state. No
 * second reactivity system: one subscription per bound element, written on
 * the store's own per-field event.
 */

import { DEV } from './dev';
import { _report } from './report';
import type { BaseBus } from './command-bus';
import { _storeOf } from './applied-remotely';
import { commandState, type CommandState } from './command-state';
import { _mountAttribute, _unmountCommand } from './command-binding';

/** The class the command binding sets while a press is in flight; a pending binding sets the same. */
const LOADING_CLASS = 'vc-loading';

/** What a row's command binding needs: mount one element, unmount it. */
type RowCommands = { mount(el: Element): void; unmount(el: Element): void };

/**
 * `value` read down `parts`, each an own property: an inherited name
 * (`constructor`) reads undefined, as src/dict.ts rules for external keys.
 */
function read(value: unknown, parts: string[], from: number): unknown {
  let v = value;
  for (let i = from; i < parts.length; i++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, parts[i])) return undefined;
    v = (v as Record<string, unknown>)[parts[i]];
  }
  return v;
}

/** Shown: truthy, and not an empty array. */
const shown = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : !!v);

function text(el: Element, v: unknown): void {
  el.textContent = v === null || v === undefined ? '' : String(v);
}

/** A row's own bindings, read from its item: `data-vc-text` and `data-vc-show`. */
function renderRow(row: DocumentFragment, item: unknown): void {
  for (const el of row.querySelectorAll('[data-vc-text]')) text(el, read(item, el.getAttribute('data-vc-text')!.split('.'), 0));
  for (const el of row.querySelectorAll('[data-vc-show]')) (el as HTMLElement).hidden = !shown(read(item, el.getAttribute('data-vc-show')!.split('.'), 0));
}

/**
 * bindDisplay - display bindings on plain HTML: every bound element under
 * `root` (and `root` itself) follows a store of `bus` or its command state.
 *
 * A path is `<store id>.<field>[.<more>]`, rendered at bind time and on each
 * write of the field (the store's `$onField`, one subscription per element):
 * `data-vc-text` sets the text, `data-vc-show` hides the element unless the
 * value is truthy and not an empty array, `data-vc-each` clones its
 * `<template>` once per entry, a row's paths reading its item and its
 * `[data-vc-command]` bound as `bindCommands` binds. `data-vc-pending="action"`
 * (with `data-vc-target`, `{}` when absent, as a command's) sets `vc-loading`
 * while that action and target is in flight on the bus, from any caller.
 * `data-vc-router="loading"` (or `"revalidating"`) sets `vc-loading` while
 * the router loads (or refreshes a page), as the bus hears it from
 * `routerFacts(router, bus)`: the bindings import no router.
 * Each path segment is an own property. A store missing at bind time leaves
 * the markup and warns in development. Returns `unbind()`.
 *
 * @example
 * <span data-vc-text="cart.count">0</span>
 * <ul data-vc-each="cart.items"><template><li data-vc-text="name"></li></template></ul>
 * <span data-vc-pending="cartAdd" data-vc-target='{"id":1}'>saving</span>
 * <script>
 *   const useCart = VaporChamber.defineChamberStore('cart', { state, reducers });
 *   useCart(bus);
 *   VaporChamber.bindDisplay(document.body, { bus });
 * </script>
 */
export function bindDisplay(root: Element | Document, options: { bus: BaseBus }): () => void {
  const bus = options.bus;
  const offs: Array<() => void> = [];
  const busOf = (): BaseBus => bus;
  bindAll(root, bus, offs, { mount: (el: Element): void => _mountAttribute(el, busOf), unmount: _unmountCommand });
  return () => {
    for (const off of offs) off();
    offs.length = 0;
  };
}

function bindAll(root: Element | Document, bus: BaseBus, offs: Array<() => void>, rows: RowCommands): void {
  const each = (el: Element, attr: string, render: (v: unknown) => void): void => {
    const path = el.getAttribute(attr)!;
    const parts = path.split('.');
    const store = parts.length > 1 ? _storeOf(bus, parts[0]) : undefined;
    if (store === undefined) {
      if (DEV) _report('warn', 'bind:missing:store', `${attr}="${path}": no store "${parts[0]}" on this bus when bindDisplay ran, so the element keeps its markup. Create the store first, as "<id>.<field>".`);
      return;
    }
    const field = parts[1];
    render(read(store.state.value, parts, 1));
    offs.push(store.$onField(field, (v) => render(read(v, parts, 2))));
  };

  // `root` itself too, as `bindCommands` binds it.
  const all = (selector: string): Element[] => {
    const found = [...root.querySelectorAll(selector)];
    if ((root as Element).nodeType === 1 && (root as Element).matches(selector)) found.unshift(root as Element);
    return found;
  };
  for (const el of all('[data-vc-text]')) each(el, 'data-vc-text', (v) => text(el, v));
  for (const el of all('[data-vc-show]')) each(el, 'data-vc-show', (v) => { (el as HTMLElement).hidden = !shown(v); });
  for (const el of all('[data-vc-each]')) {
    const template = el.querySelector(':scope > template') as HTMLTemplateElement | null;
    if (template === null) continue;
    let rendered: Element[] = [];
    // A row's commands, its root among them, unbound on a rebuild and on unbind.
    const unmountRow = (node: Element): void => {
      for (const c of node.querySelectorAll('[data-vc-command]')) rows.unmount(c);
      if (node.hasAttribute('data-vc-command')) rows.unmount(node);
    };
    each(el, 'data-vc-each', (v) => {
      for (const node of rendered) {
        unmountRow(node);
        node.remove();
      }
      rendered = [];
      if (!Array.isArray(v)) return;
      for (const item of v) {
        const row = template.content.cloneNode(true) as DocumentFragment;
        renderRow(row, item);
        for (const c of row.querySelectorAll('[data-vc-command]')) rows.mount(c);
        for (const node of row.children) rendered.push(node);
        el.append(row);
      }
    });
    offs.push(() => { for (const node of rendered) unmountRow(node); });
  }

  // The router's flags as the bus hears them (`routerFacts`: `routerLoading`,
  // `routerRevalidating`, each `{ value }`): no router import here. One
  // listener per bound element, only where one exists.
  // tests/router/router-loading-binding.test.ts.
  for (const el of all('[data-vc-router]')) {
    const flag = el.getAttribute('data-vc-router');
    const event = flag === 'loading' ? 'routerLoading' : flag === 'revalidating' ? 'routerRevalidating' : undefined;
    if (event === undefined) {
      if (DEV) _report('warn', 'bind:invalid:router', `data-vc-router="${flag as string}": the router's flags are "loading" and "revalidating", so the element is not bound.`, undefined, { flag });
      continue;
    }
    offs.push(bus.on(event, (cmd) => { el.classList.toggle(LOADING_CLASS, (cmd.target as { value: boolean }).value); }));
  }

  const pending = all('[data-vc-pending]');
  if (pending.length === 0) return;
  const state: CommandState = commandState(bus);
  const flags = pending.map((el) => {
    const raw = el.getAttribute('data-vc-target');
    // No target is `{}`, the command binding's own default, so both read one key.
    let target: unknown = {};
    if (raw) try { target = JSON.parse(raw) ?? {}; } catch { target = {}; }
    return { el, flag: state.pending(el.getAttribute('data-vc-pending')!, target) };
  });
  const render = (): void => { for (const f of flags) f.el.classList.toggle(LOADING_CLASS, f.flag.value); };
  render();
  offs.push(state.subscribe(render), state.dispose);
}
