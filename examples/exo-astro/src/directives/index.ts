/**
 * exo-style declarative directives over a vapor-chamber bus.
 *
 * Five directives, scanned once from static HTML — no framework runtime:
 *
 *   v-scope='{"open":false}'   declare reactive LOCAL state (inline JSON)
 *   v-bind-text="cart.count"   reactive textContent via dot-path
 *   v-show="cart.hasItems"     toggle display:none on path truthiness
 *   v-each="cart.items"        repeat the element's <template> child per entry,
 *                              each clone scoped to its item
 *   v-command="cart.add"       dispatch a named bus command on click,
 *                              with optional v-target / v-payload JSON
 *
 * An element that starts hidden must SAY SO in the HTML (`style="display:none"`
 * alongside its `v-show`). The script is a module — it runs after parse, so
 * anything the server marked visible stays visible until the first effect. The
 * markup owns the initial state; the directive owns every state after it.
 *
 * Discipline: the ONLY write path is v-command — every mutation goes through
 * a named command handler on the bus. Sections never touch each other's DOM
 * or state; one dispatches into the bus, the other reads reactive state.
 * Local scope state is no exception: a handler writes it through `scopeOf(el)`,
 * never the click site.
 *
 * A binding reads from the nearest v-scope that DECLARED its head key, and
 * from the global busState otherwise — so a subtree can mix local UI state and
 * bus state, and an undeclared key can never be shadowed by a scope.
 *
 * Reactivity is deliberately tiny: a Proxy per reactive object with a flat
 * effect set — any property mutation, at any depth, re-runs all of that
 * tree's effects synchronously. No dependency graph, no scheduler. For the
 * handful of bindings a static page carries, brute-force re-run is cheaper
 * than bookkeeping (and is exactly what the exo runtime does).
 */

import type { BaseBus } from 'vapor-chamber';

type Effect = () => void;

const effectsOf = new WeakMap<object, Set<Effect>>();

/** Raw targets and proxies we've already wrapped — stops double-wrapping an
 *  existing reactive, and stops a cyclic object graph recursing forever. */
const known = new WeakSet<object>();

/** Plain objects and arrays nest; anything exotic (Date, Map, DOM node, class
 *  instance) is stored as-is — wrapping it would break its internals. */
function nestable(v: unknown): v is object {
  if (v === null || typeof v !== 'object' || known.has(v)) return false;
  return Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype;
}

/** Wrap `obj` and every plain object/array under it against ONE effect set, so
 *  a nested write (`cart.count = 7`) re-runs the same effects a top-level write
 *  does — that's what makes the dot-path bindings stay live. */
function wrap<T extends object>(obj: T, fx: Set<Effect>): T {
  known.add(obj);
  for (const key of Object.keys(obj)) {
    const v = (obj as any)[key];
    if (nestable(v)) (obj as any)[key] = wrap(v, fx);
  }
  const proxy = new Proxy(obj, {
    set(target, key, value) {
      (target as any)[key] = nestable(value) ? wrap(value, fx) : value;
      for (const run of fx) run();
      return true;
    },
  });
  known.add(proxy);
  return proxy;
}

/** Wrap an object so any property mutation — at any depth — re-runs its
 *  registered effects. */
export function reactive<T extends object>(obj: T): T {
  const fx = new Set<Effect>();
  const proxy = wrap(obj, fx);
  effectsOf.set(proxy, fx);
  return proxy;
}

/** Register an effect against a reactive object: runs now, re-runs on mutation. */
export function addEffect(obj: object, run: Effect): void {
  effectsOf.get(obj)?.add(run);
  run();
}

/** Global bus-managed state — the "atmosphere" sections read from. */
export const busState = reactive<Record<string, any>>({});

/** Element → its v-scope object. Ancestor walk resolves the nearest scope. */
const scopeMap = new WeakMap<Element, object>();

/** The reactive object declared by an element's own `v-scope`, if any. */
export function scopeOf(el: Element): any {
  return scopeMap.get(el);
}

/**
 * The object a binding reads from: the nearest ancestor v-scope that *declares*
 * the path's head key, else the global busState.
 *
 * Declaring a key in `v-scope` is what makes it local — anything a scope does
 * not declare falls through to the atmosphere. So one subtree can mix local UI
 * state (`open`) and bus state (`cartCount`) without either knowing the other
 * exists, and a scope can never accidentally shadow a bus key it never named.
 */
function resolveFor(el: Element, path: string): object {
  const head = path.split('.')[0];
  let cur: Element | null = el;
  while (cur) {
    const scope = scopeMap.get(cur);
    if (scope && head in scope) return scope;
    cur = cur.parentElement;
  }
  return busState;
}

/**
 * Directives already wired, per element. Makes `scan()` idempotent so it can
 * re-run after a client-side page swap (Astro's `astro:page-load`) without
 * double-binding clicks or stacking duplicate effects.
 */
const wired = new WeakMap<Element, Set<string>>();

function claim(el: Element, directive: string): boolean {
  let done = wired.get(el);
  if (!done) wired.set(el, (done = new Set()));
  if (done.has(directive)) return false;
  done.add(directive);
  return true;
}

function getPath(obj: any, path: string): any {
  let v = obj;
  for (const key of path.split('.')) {
    if (v == null) return undefined;
    v = v[key];
  }
  return v;
}

function parseJson(s: string | null): any {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

/**
 * Scan the tree and wire all directives. Document order guarantees parent
 * v-scope objects exist before descendant bindings resolve them.
 *
 * Idempotent: re-scanning is a no-op for anything already wired, and an
 * existing v-scope keeps its live state instead of being reset to its JSON.
 * Safe to call again on `astro:page-load` after a client-side page swap.
 */
export function scan(bus: BaseBus, root: ParentNode = document): void {
  for (const el of pick(root, '[v-scope]')) {
    if (scopeMap.has(el)) continue;
    const initial = parseJson(el.getAttribute('v-scope')) ?? {};
    scopeMap.set(el, reactive(initial));
  }
  wire(bus, root);
}

/** querySelectorAll, plus the root itself when it matches — a cloned `v-each`
 *  row can carry a directive on its outermost element. */
function pick(root: ParentNode, selector: string): Element[] {
  const found = Array.from(root.querySelectorAll(selector));
  const self = root as Element;
  if (typeof self.matches === 'function' && self.matches(selector)) found.unshift(self);
  return found;
}

function wire(bus: BaseBus, root: ParentNode): void {
  for (const el of pick(root, '[v-bind-text]')) {
    if (!claim(el, 'v-bind-text')) continue;
    const path = el.getAttribute('v-bind-text')!;
    const scope = resolveFor(el, path);
    addEffect(scope, () => {
      const v = getPath(scope, path);
      el.textContent = v == null ? '' : String(v);
    });
  }

  for (const el of pick(root, '[v-show]')) {
    if (!claim(el, 'v-show')) continue;
    const path = el.getAttribute('v-show')!;
    const scope = resolveFor(el, path);
    addEffect(scope, () => {
      (el as HTMLElement).style.display = getPath(scope, path) ? '' : 'none';
    });
  }

  // v-each="items" — repeat the element's <template> child once per array
  // entry, each clone scoped to its entry (`v-bind-text="name"` reads the item).
  // The list is rebuilt wholesale on any change: for the row counts a static
  // page carries, that beats keeping a keyed diff honest.
  for (const el of pick(root, '[v-each]')) {
    if (!claim(el, 'v-each')) continue;
    const path = el.getAttribute('v-each')!;

    // The row prototype is a <template> child when one is available, else the
    // first element child, detached on wire. Both forms exist because
    // <template> is not universally safe inside table sections — the HTML spec
    // allows it, but parsers disagree, and a dropped template silently turns
    // the prototype into a real row. Authoring the row directly always works.
    const tpl = el.querySelector('template') as HTMLTemplateElement | null;
    let clone: (() => Element[]) | null = null;
    if (tpl) {
      clone = () =>
        Array.from(tpl.content.cloneNode(true).childNodes).filter(
          (n): n is Element => n.nodeType === 1,
        );
    } else if (el.firstElementChild) {
      const proto = el.firstElementChild;
      proto.remove();
      clone = () => [proto.cloneNode(true) as Element];
    }
    if (!clone) continue;

    const scope = resolveFor(el, path);
    addEffect(scope, () => {
      for (const old of Array.from(el.children)) {
        if (old !== tpl) old.remove();
      }
      const items = getPath(scope, path);
      if (!Array.isArray(items)) return;
      for (const item of items) {
        for (const row of clone()) {
          if (item !== null && typeof item === 'object') scopeMap.set(row, item);
          el.appendChild(row);
          wire(bus, row);
        }
      }
    });
  }

  for (const el of pick(root, '[v-command]')) {
    if (!claim(el, 'v-command')) continue;
    const action = el.getAttribute('v-command')!;
    el.addEventListener('click', () => {
      const target = parseJson(el.getAttribute('v-target')) ?? {};
      const payload = parseJson(el.getAttribute('v-payload'));
      bus.dispatch(action, target, payload);
    });
  }
}

/** One-call mount: scan after the DOM is ready. Returns the global busState. */
export function mountExo(bus: BaseBus, root: ParentNode = document): Record<string, any> {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scan(bus, root), { once: true });
  } else {
    scan(bus, root);
  }
  return busState;
}
