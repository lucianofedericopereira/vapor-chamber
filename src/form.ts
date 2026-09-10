/**
 * vapor-chamber - Form Bus
 *
 * v0.5.0 - Reactive form state management built on the command bus.
 *
 * createFormBus wraps a command bus around a typed form, giving you:
 *   - Reactive values, errors, dirty, valid, and submitting state
 *   - Per-field validation rules
 *   - Full plugin pipeline on every form command (logger, throttle, authGuard, etc.)
 *   - Undo/redo via the history plugin
 *
 * @example
 * const form = createFormBus({
 *   fields: { email: '', password: '' },
 *   rules: {
 *     email:    (v) => v.includes('@') ? null : 'Invalid email',
 *     password: (v) => v.length >= 8   ? null : 'Too short',
 *   },
 *   onSubmit: async (values) => await api.login(values),
 * });
 *
 * form.set('email', 'user@example.com');
 * await form.submit();   // runs validation, then onSubmit
 * form.reset();          // restores initial field values
 */

import { signal } from './signal';
import type { Signal, CreateSignal } from './signal';
import { createCommandBus } from './command-bus';
import type { CommandBus, Plugin, PluginOptions } from './command-bus';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FormRules<T extends Record<string, any>> = {
  [K in keyof T]?: (value: T[K], values: T) => string | null | Promise<string | null>;
};

export type FormBusOptions<T extends Record<string, any>> = {
  /** Initial field values - also used as the reset target. */
  fields: T;
  /** Per-field validation rules. Return a string on error, null on pass. */
  rules?: FormRules<T>;
  /** Called after successful validation on submit(). May be async. */
  onSubmit?: (values: T) => void | Promise<void>;
  /**
   * Create reactive signals for all form state (values, errors, isDirty, etc.).
   * Default: true. Set to false for headless / server-side / batch use cases
   * where reactivity is not needed - avoids 7 signal allocations per form.
   * When false, all Signal fields still work as plain get/set wrappers.
   */
  reactive?: boolean;
  /**
   * Inject an external command bus instead of creating an isolated one.
   * When provided, form commands (formSet, formTouch, formReset, formValidate)
   * flow through this bus - making them visible to DevTools, metrics, logger,
   * and global listeners.
   *
   * @example
   * const bus = getCommandBus();
   * const form = createFormBus({ fields: { email: '' }, bus });
   * // formSet, formTouch, etc. now visible in setupDevtools()
   */
  bus?: CommandBus;
  /**
   * Action-name prefix, so two forms can share one bus. Default: `'form'`,
   * which is exactly the names this module has always used - a single form is
   * unchanged.
   *
   * REQUIRED FOR THE SECOND FORM ON A SHARED BUS, and the reason is not
   * tidiness. The four action names are constants, so a second
   * `createFormBus({ bus })` re-registered `formSet` over the first form's and
   * every later `login.set(...)` wrote into the SIGNUP form's state. Measured:
   * with a login and a signup form on one bus, `login.set('email', 'a@b.c')`
   * left `login.values` empty and put the email in `signup.values`. The bus
   * does warn on an overwrite, but only in dev, and only as a generic
   * "handler already exists" - four times, once per action.
   *
   *   const login  = createFormBus({ fields: {...}, bus, id: 'login' });
   *   const signup = createFormBus({ fields: {...}, bus, id: 'signup' });
   *   // loginSet / signupSet - distinct in devtools, and no cross-writing
   */
  id?: string;
};

export type FormBus<T extends Record<string, any>> = {
  /** Reactive current field values. */
  values: Signal<T>;
  /** Reactive per-field error messages. Empty when all fields pass. */
  errors: Signal<Partial<Record<keyof T, string>>>;
  /** Reactive set of fields the user has interacted with. */
  touched: Signal<Partial<Record<keyof T, boolean>>>;
  /** True when any field differs from its initial value. */
  isDirty: Signal<boolean>;
  /** True when no validation errors exist. */
  isValid: Signal<boolean>;
  /** True while onSubmit is in flight. */
  isSubmitting: Signal<boolean>;
  /** True while async validation is running. */
  isValidating: Signal<boolean>;
  /** True when either validating or submitting - use for disabling submit buttons. */
  isBusy: Signal<boolean>;
  /** Set a single field value and re-run validation. */
  set<K extends keyof T>(field: K, value: T[K]): void;
  /** Mark a field as touched (shows errors for that field). */
  touch<K extends keyof T>(field: K): void;
  /** Validate and call onSubmit. Returns true on success, false on validation failure. */
  submit(): Promise<boolean>;
  /** Reset all fields to their initial values and clear errors/touched state. */
  reset(): void;
  /** Attach a plugin to the form's internal command bus. */
  use(plugin: Plugin, options?: PluginOptions): void;
  /** The underlying command bus - for advanced use (DevTools, testing). */
  bus: CommandBus;
  /**
   * Unregister this form's handlers from the bus and release its prefix.
   *
   * Only meaningful with an INJECTED bus: an isolated one is garbage with the
   * form. Without it there was no way to take a form off a shared bus at all,
   * so a modal form registered its handlers for the life of the page and its
   * prefix stayed claimed.
   */
  dispose(): void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sync-only validation used for live per-field feedback during set(). Skips async rules. */
function runRulesSync<T extends Record<string, any>>(
  rules: FormRules<T>,
  values: T,
): Partial<Record<keyof T, string>> {
  const errs: Partial<Record<keyof T, string>> = {};
  for (const key in rules) {
    // Object.hasOwn, not `in` - see ../dict. A field literally named `toString`
    // or `constructor` would otherwise validate against an inherited function
    // rather than be skipped as absent.
    if (!Object.hasOwn(values, key)) continue;
    const rule = rules[key as keyof T];
    if (!rule) continue;
    const msg = rule(values[key as keyof T], values);
    if (typeof msg === 'string') errs[key as keyof T] = msg;
  }
  return errs;
}

/** Awaits all rules (sync and async). Used in submit() for full validation. */
async function runRulesAsync<T extends Record<string, any>>(
  rules: FormRules<T>,
  values: T,
): Promise<Partial<Record<keyof T, string>>> {
  const errs: Partial<Record<keyof T, string>> = {};
  // Run fields concurrently - two 300ms server-side validators cost 300ms, not
  // 600ms. Sync rules resolve immediately; per-field error mapping is preserved.
  const keys: Array<keyof T> = [];
  const results: Array<string | null | undefined | Promise<string | null | undefined>> = [];
  for (const key in rules) {
    if (!Object.hasOwn(values, key)) continue; // see ../dict
    const rule = rules[key as keyof T];
    if (!rule) continue;
    keys.push(key as keyof T);
    results.push(rule(values[key as keyof T], values));
  }
  const settled = await Promise.all(results);
  for (let i = 0; i < keys.length; i++) {
    if (settled[i]) errs[keys[i]] = settled[i] as string;
  }
  return errs;
}

function hasDiff<T extends Record<string, any>>(a: T, b: T): boolean {
  return Object.keys(b).some((k) => a[k] !== b[k]);
}

// ---------------------------------------------------------------------------
// createFormBus
// ---------------------------------------------------------------------------

/**
 * createFormBus - reactive form state manager built on the command bus.
 *
 * All form mutations go through the internal bus, so plugins (logger,
 * throttle, authGuard, etc.) intercept them like any other command.
 */
export function createFormBus<T extends Record<string, any>>(
  options: FormBusOptions<T>,
): FormBus<T> {
  const { onSubmit, reactive: useReactive = true, id = 'form' } = options;
  const rules = (options.rules ?? {}) as FormRules<T>;
  const initial: T = { ...options.fields };

  const bus = options.bus ?? createCommandBus();

  // Claim the prefix on this bus, or say precisely what went wrong. An isolated
  // bus cannot collide with anything, so only an injected one is tracked.
  // The claim set lives ON THE BUS, not in a module-level WeakMap. Two reasons,
  // and the second is the one that decided it: the bus is exactly the scope a
  // claim belongs to (it dies with the bus, no registry to leak), and a
  // module-level declaration in this file shifts esbuild identifier allocation
  // across the whole inlined barrel - measured at one byte over the tree-shake
  // ceiling in a consumer that never calls createFormBus. Nothing here is
  // retained by such a consumer; the byte was pure allocation noise, and the
  // way to not pay it is to add no module scope.
  const holder = options.bus as unknown as { __vcFormIds?: Set<string> };
  const claimed = options.bus ? (holder.__vcFormIds ??= new Set<string>()) : null;
  if (claimed?.has(id)) {
    // SHORT ON PURPOSE. This string is inlined into `dist/index.js` with the
    // rest of the barrel, and `esm-treeshake.test.ts` measures a consumer that
    // never calls createFormBus - the fuller wording cost a byte over that
    // ceiling. The explanation lives in the `id` docblock, which ships in src
    // and costs the bundle nothing.
    throw new Error(`[vapor-chamber] form id "${id}" already on this bus - pass a distinct id.`);
  }
  claimed?.add(id);

  const ACTION_SET = `${id}Set`;
  const ACTION_TOUCH = `${id}Touch`;
  const ACTION_RESET = `${id}Reset`;
  const ACTION_VALIDATE = `${id}Validate`;

  // When reactive: false, use plain get/set wrappers instead of Vue signals.
  // Saves 7 signal allocations per form in headless/batch/SSR contexts.
  const sig: CreateSignal = useReactive ? signal : <V>(v: V): Signal<V> => {
    let _val = v;
    return { get value() { return _val; }, set value(v: V) { _val = v; } };
  };

  const values    = sig<T>({ ...initial });
  const errors    = sig<Partial<Record<keyof T, string>>>({});
  const touched   = sig<Partial<Record<keyof T, boolean>>>({});
  const isDirty   = sig(false);
  const isValid   = sig(true);
  const isSubmitting = sig(false);
  const isValidating = sig(false);
  const isBusy   = sig(false);

  /** True from the synchronous entry of submit() until it settles - see submit(). */
  let submitInFlight = false;

  /** Update isBusy whenever isSubmitting or isValidating changes */
  function updateBusy(): void {
    isBusy.value = isSubmitting.value || isValidating.value;
  }

  // ---- formSet -----------------------------------------------------------
  const offs: Array<() => void> = [];
  offs.push(bus.register(ACTION_SET, (cmd) => {
    const { field, value } = cmd.payload as { field: keyof T; value: T[keyof T] };
    const next = { ...values.value, [field]: value } as T;
    values.value  = next;
    const errs    = runRulesSync(rules, next);
    errors.value  = errs;
    isDirty.value = hasDiff(initial, next);
    isValid.value = Object.keys(errs).length === 0;
    return next;
  }));

  // ---- formTouch ---------------------------------------------------------
  offs.push(bus.register(ACTION_TOUCH, (cmd) => {
    const { field } = cmd.payload as { field: keyof T };
    touched.value = { ...touched.value, [field]: true };
    return touched.value;
  }));

  // ---- formReset ---------------------------------------------------------
  offs.push(bus.register(ACTION_RESET, () => {
    values.value   = { ...initial };
    errors.value   = {};
    touched.value  = {};
    isDirty.value  = false;
    isValid.value  = true;
    isSubmitting.value = false;
    isValidating.value = false;
    isBusy.value   = false;
    return values.value;
  }));

  // ---- formValidate (internal) ------------------------------------------
  offs.push(bus.register(ACTION_VALIDATE, () => {
    // Touch all fields so errors become visible
    const allTouched: Partial<Record<keyof T, boolean>> = {};
    for (const k in initial) allTouched[k as keyof T] = true;
    touched.value = allTouched;

    const errs   = runRulesSync(rules, values.value);
    errors.value = errs;
    isValid.value = Object.keys(errs).length === 0;
    return { valid: isValid.value, errors: errs };
  }));

  // ---- Public API --------------------------------------------------------

  function set<K extends keyof T>(field: K, value: T[K]): void {
    bus.dispatch(ACTION_SET, {}, { field, value });
  }

  function touch<K extends keyof T>(field: K): void {
    bus.dispatch(ACTION_TOUCH, {}, { field });
  }

  function reset(): void {
    bus.dispatch(ACTION_RESET, {});
  }

  async function submit(): Promise<boolean> {
    // Re-entry guard. First-write-wins is chosen over supersede semantics
    // because the in-flight call may already have reached the server -
    // cancelling the *local* half of a submit that has been sent is the more
    // surprising of the two. Callers wanting last-write-wins have the
    // `supersede` plugin.
    //
    // The latch is a plain closure boolean set SYNCHRONOUSLY on entry, not the
    // `isSubmitting` signal. `isSubmitting` only turns true after validation
    // resolves, and `submit()` always awaits `runRulesAsync` - so gating on it
    // left the entire validation phase unguarded, and two clicks in the same
    // turn (a real double-click, rather than a second click after the first
    // reached `onSubmit`) both passed the guard: two `onSubmit` round-trips,
    // and two `finally` blocks fighting over isSubmitting/isValidating.
    if (submitInFlight) return false;
    submitInFlight = true;
    try {
      return await runSubmit();
    } finally {
      submitInFlight = false;
    }
  }

  async function runSubmit(): Promise<boolean> {
    // Touch all fields so errors become visible
    const allTouched: Partial<Record<keyof T, boolean>> = {};
    for (const k in initial) allTouched[k as keyof T] = true;
    touched.value = allTouched;

    // ONE snapshot, validated and submitted. `values` is live state and this
    // function reads it across an await: validation ran against the values at
    // call time (the module's own pitch for concurrent rules is a 300ms
    // server-side validator), while `onSubmit` then read whatever was current
    // when it resolved. A `set()` landing in that window meant validation
    // passed values that were never submitted, and values were submitted that
    // were never validated.
    const snapshot = { ...values.value } as T;

    // Run all rules - awaits async validators too
    // Set isValidating so the UI can show loading state during async validation
    isValidating.value = true;
    updateBusy();
    try {
      const errs = await runRulesAsync(rules, snapshot);
      errors.value = errs;
      isValid.value = Object.keys(errs).length === 0;
    } finally {
      isValidating.value = false;
      updateBusy();
    }
    if (!isValid.value) return false;

    isSubmitting.value = true;
    updateBusy();
    try {
      if (onSubmit) await onSubmit(snapshot);
      return true;
    } finally {
      isSubmitting.value = false;
      updateBusy();
    }
  }

  function use(plugin: Plugin, pluginOptions?: PluginOptions): void {
    bus.use(plugin, pluginOptions);
  }

  function dispose(): void {
    for (const off of offs) off();
    offs.length = 0;
    claimed?.delete(id);
  }

  return { values, errors, touched, isDirty, isValid, isSubmitting, isValidating, isBusy, set, touch, submit, reset, use, bus, dispose };
}
