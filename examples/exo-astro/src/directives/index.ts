/**
 * exo-style declarative directives over a vapor-chamber bus.
 *
 * Four directives, scanned once from static HTML — no framework runtime:
 *
 *   v-scope='{"open":false}'   declare reactive LOCAL state (inline JSON)
 *   v-bind-text="cart.count"   reactive textContent via dot-path
 *   v-show="cart.hasItems"     toggle display:none on path truthiness
 *   v-command="cart.add"       dispatch a named bus command on click,
 *                              with optional v-target / v-payload JSON
 *
 * Discipline: the ONLY write path is v-command — every mutation goes through
 * a named command handler on the bus. Sections never touch each other's DOM
 * or state; one dispatches into the bus, the other reads reactive state.
 *
 * Reactivity is deliberately tiny: a Proxy per reactive object with a flat
 * effect set — any property mutation re-runs all of that object's effects
 * synchronously. No dependency graph, no scheduler. For the handful of
 * bindings a static page carries, brute-force re-run is cheaper than
 * bookkeeping (and is exactly what the exo runtime does).
 */

import type { BaseBus } from 'vapor-chamber';

type Effect = () => void;

const effectsOf = new WeakMap<object, Set<Effect>>();

/** Wrap an object so any property mutation re-runs its registered effects. */
export function reactive<T extends object>(obj: T): T {
  const fx = new Set<Effect>();
  const proxy = new Proxy(obj, {
    set(target, key, value) {
      (target as any)[key] = value;
      for (const run of fx) run();
      return true;
    },
  });
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

function resolveScope(el: Element): object {
  let cur: Element | null = el;
  while (cur) {
    const scope = scopeMap.get(cur);
    if (scope) return scope;
    cur = cur.parentElement;
  }
  return busState;
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
 */
export function scan(bus: BaseBus, root: ParentNode = document): void {
  for (const el of root.querySelectorAll('[v-scope]')) {
    const initial = parseJson(el.getAttribute('v-scope')) ?? {};
    scopeMap.set(el, reactive(initial));
  }

  for (const el of root.querySelectorAll('[v-bind-text]')) {
    const path = el.getAttribute('v-bind-text')!;
    const scope = resolveScope(el);
    addEffect(scope, () => {
      const v = getPath(scope, path);
      el.textContent = v == null ? '' : String(v);
    });
  }

  for (const el of root.querySelectorAll('[v-show]')) {
    const path = el.getAttribute('v-show')!;
    const scope = resolveScope(el);
    addEffect(scope, () => {
      (el as HTMLElement).style.display = getPath(scope, path) ? '' : 'none';
    });
  }

  for (const el of root.querySelectorAll('[v-command]')) {
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
