/**
 * vapor-chamber - Form Bus
 *
 * Reactive form state management built on the command bus.
 *
 * createFormBus wraps a command bus around a typed form, giving you:
 *   - Reactive values, errors, dirty, valid, and submitting state
 *   - Per-field validation rules
 *   - Full plugin pipeline on every form command (logger, authGuard, etc.)
 *
 * `history()` records form commands, but its undo restores no field: the
 * form registers no inverse (an undo without one only moves the stacks).
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

import { dict } from './dict';
import { signal } from './signal';
import type { Signal, CreateSignal } from './signal';
import { createCommandBus } from './command-bus';
import type { CommandBus, PluginParts } from './command-bus';
import { _busStores } from './applied-remotely';
import { _fieldCell } from './store-base';
import { _registerLocal } from './library-names';
import { _definePlainStore } from './store/core';

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
   * where reactivity is not needed - avoids eight signal allocations per form.
   * When false, all Signal fields still work as plain get/set wrappers.
   */
  reactive?: boolean;
  /**
   * Inject an external command bus instead of creating an isolated one.
   * When provided, form commands (formSet, formTouch, formReset, formValidate,
   * formErrors) flow through this bus - making them visible to DevTools, metrics, logger,
   * and global listeners.
   *
   * @example
   * const bus = getCommandBus();
   * const form = createFormBus({ fields: { email: '' }, bus });
   * // formSet, formTouch, etc. now visible in setupDevtools()
   */
  bus?: CommandBus;
  /**
   * Action-name prefix, so two forms can share one bus. Default: `'form'`
   * (`formSet`, `formTouch`, ...).
   *
   * REQUIRED FOR THE SECOND FORM ON A SHARED BUS, and the reason is not
   * tidiness. The five action names derive from it, so two forms with one id
   * would register over each other: measured with a login and a signup form
   * on one bus, `login.set('email', 'a@b.c')` left `login.values` empty and
   * put the email in `signup.values`. So a second form whose id is already on
   * the bus throws (tests/store-form-sharing.test.ts).
   *
   *   const login  = createFormBus({ fields: {...}, bus, id: 'login' });
   *   const signup = createFormBus({ fields: {...}, bus, id: 'signup' });
   *   // loginSet / signupSet - distinct in devtools, and no cross-writing
   */
  id?: string;
};

/**
 * Errors from outside the form's rules, in the wire contract's one shape
 * (docs/contract.md 4): a problem's `errors`, each a
 * pointer into the envelope the client sent (`/payload/<field>`, RFC 6901)
 * and its sentence.
 */
export type FormErrorsInput = ReadonlyArray<{ pointer: string; detail: string }>;

/** What an element needs to make a field's error accessible (WCAG 3.3.1, 4.1.2). */
export type FieldAria = {
  'aria-invalid': 'true' | undefined;
  'aria-describedby': string | undefined;
};

/** A form's one state, held by its store: what the five commands and `submit()` write. */
type FormState<T extends Record<string, any>> = {
  values: T;
  errors: Partial<Record<keyof T, string>>;
  touched: Partial<Record<keyof T, boolean>>;
  /** Errors from outside the rules, by field; merged over the rule errors. */
  outside: Partial<Record<keyof T, string>>;
  isDirty: boolean;
  isValid: boolean;
};

export type FormBus<T extends Record<string, any>> = {
  /** Reactive current field values. Read-only: `set()` writes them. */
  readonly values: { readonly value: T };
  /** Reactive per-field error messages. Empty when all fields pass. */
  readonly errors: { readonly value: Partial<Record<keyof T, string>> };
  /** Reactive set of fields the user has interacted with. */
  readonly touched: { readonly value: Partial<Record<keyof T, boolean>> };
  /** True when any field differs from its initial value. */
  readonly isDirty: { readonly value: boolean };
  /** True when no validation errors exist. */
  readonly isValid: { readonly value: boolean };
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
  /** Validate and call onSubmit. Returns true on success; false on validation failure, a reset during validation, or a submit already in flight. */
  submit(): Promise<boolean>;
  /** Reset all fields to their initial values and clear errors/touched state. */
  reset(): void;
  /**
   * Show errors from outside the rules (a server's answer), replacing earlier
   * ones. Each marks its field touched, so it shows at once, and clears when
   * that field changes; `submit()` clears them all, since the server decides
   * again. `submit()` calls this itself when `onSubmit` throws an error whose
   * problem carries `errors`.
   */
  setErrors(errors: FormErrorsInput): void;
  /**
   * `aria-invalid` / `aria-describedby` for a field: invalid only while its
   * error is shown. `describedBy`, the input's own ids (a hint), stays named,
   * and the error's id follows it while shown, since `aria-describedby` is an
   * ID reference list (WAI-ARIA 1.2). Spread it in place of a static
   * `aria-describedby`: the spread's value overrides the attribute.
   * tests/form-aria-render.test.ts.
   */
  aria<K extends keyof T>(field: K, describedBy?: string): FieldAria;
  /** The id for the element holding a field's message: stable, unique per form, a valid id. */
  errorId<K extends keyof T>(field: K): string;
  /** The first field, in declaration order, whose error is shown - the one to focus after a failed submit. */
  firstInvalid(): keyof T | undefined;
  /** Attach a plugin to the form's internal command bus. */
  use(plugin: PluginParts): void;
  /** The underlying command bus - for advanced use (DevTools, testing). */
  bus: CommandBus;
  /**
   * Unregister this form's handlers from the bus and release its prefix.
   *
   * Only meaningful with an INJECTED bus: an isolated one is garbage with the
   * form. It is how a short-lived form (a modal) leaves a shared bus.
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

let formSeq = 0;

/**
 * The form field a pointer names: `/payload/<field>` (RFC 6901, `~1` and `~0`
 * unescaped), nested segments joined by dots, so `/payload/address/city` is
 * `address.city`. A pointer outside the payload, or to no field, names none.
 */
function fieldOf(pointer: string, fields: object): string | undefined {
  const segments = pointer.split('/');
  if (segments[0] !== '' || segments[1] !== 'payload') return undefined;
  const name = segments.slice(2).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~')).join('.');
  return Object.hasOwn(fields, name) ? name : undefined;
}

/** The first error per field, for the fields the form has. */
function normalizeErrors(input: FormErrorsInput, fields: object): Record<string, string> {
  const out = dict<string>();
  for (const e of input) {
    const field = fieldOf(e.pointer, fields);
    if (field !== undefined && !Object.hasOwn(out, field)) out[field] = e.detail;
  }
  return out;
}

/** The field errors a failure carries: a backend problem's `errors`, in its `context`. */
function fieldErrorsOf(error: unknown): FormErrorsInput | undefined {
  const errors = (error as { context?: { errors?: unknown } } | null)?.context?.errors;
  return Array.isArray(errors) ? (errors as FormErrorsInput) : undefined;
}

function hasDiff<T extends Record<string, any>>(a: T, b: T): boolean {
  for (const k in b) if (a[k] !== b[k]) return true;
  return false;
}

/** No own key, with no array of them. A spread stays what copies keys: an assignment would hit `__proto__`'s setter (see ../dict). */
function noKeys(o: object): boolean {
  for (const k in o) if (Object.hasOwn(o, k)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// createFormBus
// ---------------------------------------------------------------------------

/**
 * createFormBus - reactive form state manager built on the command bus.
 *
 * All form mutations go through the internal bus, so plugins (logger,
 * authGuard, etc.) intercept them like any other command.
 */
export function createFormBus<T extends Record<string, any>>(
  options: FormBusOptions<T>,
): FormBus<T> {
  const { onSubmit, reactive: useReactive = true, id = 'form' } = options;
  const rules = (options.rules ?? {}) as FormRules<T>;
  const initial: T = { ...options.fields };

  const bus = options.bus ?? createCommandBus();

  // A second form with this id on the bus, or any store holding it, would
  // write over this one: the explanation lives in the `id` docblock. An
  // isolated bus cannot collide with anything.
  if (options.bus && _busStores.get(options.bus)?.entries.has(id)) {
    throw new Error(`[vapor-chamber] form id "${id}" already on this bus - pass a distinct id.`);
  }

  const ACTION_SET = `${id}Set`;
  const ACTION_TOUCH = `${id}Touch`;
  const ACTION_RESET = `${id}Reset`;
  const ACTION_VALIDATE = `${id}Validate`;
  const ACTION_ERRORS = `${id}Errors`;
  const domPrefix = `vc-${id}-${++formSeq}`;
  const fresh = (): FormState<T> => ({ values: { ...initial }, errors: {}, touched: {}, outside: {}, isDirty: false, isValid: true });
  /** Every field touched, so every error shows. */
  const allTouched = (): Partial<Record<keyof T, boolean>> => {
    const all: Partial<Record<keyof T, boolean>> = {};
    for (const k in initial) all[k as keyof T] = true;
    return all;
  };
  /** The command `submit()`'s writes are a step of: a `$` name, the library's, never dispatched. */
  const SUBMIT = { action: `${id}$submit`, target: undefined };

  // The form's state is one store: values, errors, touched,
  // the errors from outside the rules, and isDirty / isValid derived where
  // each write builds it. Each command writes it once, through the store's
  // own write (a step of that command), so no reader sees a half-written
  // form. Each public cell is its own signal over the store's field events
  // (`_fieldCell`, as `fieldRef`): a reader of `isValid` re-runs when it
  // flips, not on every keystroke. reactive: false makes them plain cells.
  // tests/form-on-store.test.ts.
  const store = _definePlainStore(id, { state: fresh, reducers: {} })(bus);
  const write = (_busStores.get(bus)!.entries.get(id) as { write: (cmd: { action: string; target: any; payload?: any }, next: FormState<T>) => void }).write;
  const sig: CreateSignal = useReactive ? signal : <V>(v: V): Signal<V> => ({ value: v }) as Signal<V>;
  const values = _fieldCell(store, 'values', sig);
  const errors = _fieldCell(store, 'errors', sig);
  const touched = _fieldCell(store, 'touched', sig);
  const isDirty = _fieldCell(store, 'isDirty', sig);
  const isValid = _fieldCell(store, 'isValid', sig);
  const isSubmitting = sig(false);
  const isValidating = sig(false);
  const isBusy   = sig(false);

  /** True from the synchronous entry of submit() until it settles - see submit(). */
  let submitInFlight = false;
  /** Bumped by every reset: a submit still validating when it changes was
   *  cancelled by it, so its results are dropped and onSubmit never runs. */
  let resets = 0;

  /** Update isBusy whenever isSubmitting or isValidating changes */
  function updateBusy(): void {
    isBusy.value = isSubmitting.value || isValidating.value;
  }

  // ---- formSet -----------------------------------------------------------
  const offs: Array<() => void> = [];
  offs.push(_registerLocal(bus, ACTION_SET, (cmd) => {
    const { field, value } = cmd.payload as { field: keyof T; value: T[keyof T] };
    const s = store.state.value;
    const next = { ...s.values, [field]: value } as T;
    let outside = s.outside;
    if (Object.hasOwn(outside, field)) {
      outside = { ...outside };
      delete outside[field];
    }
    const ruled = runRulesSync(rules, next);
    const errs = noKeys(outside) ? ruled : { ...ruled, ...outside };
    write(cmd, { values: next, errors: errs, touched: s.touched, outside, isDirty: hasDiff(initial, next), isValid: noKeys(errs) });
    return next;
  }));

  // ---- formTouch ---------------------------------------------------------
  offs.push(_registerLocal(bus, ACTION_TOUCH, (cmd) => {
    const { field } = cmd.payload as { field: keyof T };
    const s = store.state.value;
    const shown = { ...s.touched, [field]: true };
    write(cmd, { ...s, touched: shown });
    return shown;
  }));

  // ---- formReset ---------------------------------------------------------
  offs.push(_registerLocal(bus, ACTION_RESET, (cmd) => {
    resets++;
    const next = fresh();
    write(cmd, next);
    isSubmitting.value = false;
    isValidating.value = false;
    isBusy.value   = false;
    return next.values;
  }));

  // ---- formValidate (internal) ------------------------------------------
  offs.push(_registerLocal(bus, ACTION_VALIDATE, (cmd) => {
    // Touch all fields so errors become visible
    const s = store.state.value;
    const errs = { ...runRulesSync(rules, s.values), ...s.outside };
    const valid = Object.keys(errs).length === 0;
    write(cmd, { ...s, touched: allTouched(), errors: errs, isValid: valid });
    return { valid, errors: errs };
  }));

  offs.push(_registerLocal(bus, ACTION_ERRORS, (cmd) => {
    const s = store.state.value;
    const outside = normalizeErrors(cmd.payload as FormErrorsInput, initial) as Partial<Record<keyof T, string>>;
    const shown: Partial<Record<keyof T, boolean>> = { ...s.touched };
    for (const k in outside) shown[k as keyof T] = true;
    const errs = { ...runRulesSync(rules, s.values), ...outside };
    write(cmd, { ...s, touched: shown, outside, errors: errs, isValid: Object.keys(errs).length === 0 });
    return errs;
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
    // Touch all fields so errors become visible; the server decides again, so
    // its errors go. Written as the store's own write, not a command.
    write(SUBMIT, { ...store.state.value, touched: allTouched(), outside: {} });

    // ONE snapshot, validated and submitted. `values` is live state and this
    // function reads it across an await: validation ran against the values at
    // call time (the module's own pitch for concurrent rules is a 300ms
    // server-side validator), while `onSubmit` then read whatever was current
    // when it resolved. A `set()` landing in that window meant validation
    // passed values that were never submitted, and values were submitted that
    // were never validated.
    const snapshot = { ...store.state.value.values } as T;
    const generation = resets;

    // Run all rules - awaits async validators too
    // Set isValidating so the UI can show loading state during async validation.
    // The write is inside the try, as `isSubmitting`'s is below: a sync
    // subscriber that throws on it cannot leave the flag stuck on true (pinned
    // by tests/form-throwing-subscriber.test.ts).
    try {
      isValidating.value = true;
      updateBusy();
      const errs = await runRulesAsync(rules, snapshot);
      // A reset while the rules ran discarded the snapshot they judged:
      // writing their verdict would show errors for values the form no longer
      // holds, and submitting would send them. The reset cancels this submit.
      if (generation !== resets) return false;
      write(SUBMIT, { ...store.state.value, errors: errs, isValid: Object.keys(errs).length === 0 });
    } finally {
      isValidating.value = false;
      updateBusy();
    }
    if (!store.state.value.isValid) return false;

    try {
      isSubmitting.value = true;
      updateBusy();
      if (onSubmit) await onSubmit(snapshot);
      return true;
    } catch (error) {
      // A refusal that names its fields (a 422 problem's `errors`) lands on
      // them and the submit reports false; anything else rejects.
      const fieldErrors = fieldErrorsOf(error);
      if (!fieldErrors || Object.keys(normalizeErrors(fieldErrors, initial)).length === 0) throw error;
      setErrors(fieldErrors);
      return false;
    } finally {
      isSubmitting.value = false;
      updateBusy();
    }
  }

  function setErrors(input: FormErrorsInput): void {
    bus.dispatch(ACTION_ERRORS, {}, input);
  }

  function errorId<K extends keyof T>(field: K): string {
    return `${domPrefix}-${String(field).replace(/[^\w-]/g, '-')}-error`;
  }

  // The field cells, not the plain store state: a render that calls aria() or
  // firstInvalid() then follows the error.
  function shownError<K extends keyof T>(field: K): string | undefined {
    return touched.value[field] ? errors.value[field] : undefined;
  }

  function aria<K extends keyof T>(field: K, describedBy?: string): FieldAria {
    const shown = shownError(field) !== undefined;
    const ids = shown ? (describedBy ? `${describedBy} ${errorId(field)}` : errorId(field)) : describedBy;
    return { 'aria-invalid': shown ? 'true' : undefined, 'aria-describedby': ids || undefined };
  }

  function firstInvalid(): keyof T | undefined {
    for (const k in initial) if (shownError(k as keyof T) !== undefined) return k as keyof T;
    return undefined;
  }

  function use(plugin: PluginParts): void {
    bus.use(plugin);
  }

  function dispose(): void {
    for (const off of offs) off();
    offs.length = 0;
    store.$dispose();
  }

  return { values, errors, touched, isDirty, isValid, isSubmitting, isValidating, isBusy, set, touch, submit, reset, setErrors, aria, errorId, firstInvalid, use, bus, dispose };
}
