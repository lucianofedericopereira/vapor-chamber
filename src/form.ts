/**
 * vapor-chamber - Form Bus
 *
 * v0.5.0 — Reactive form state management built on the command bus.
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

import { signal } from './chamber';
import type { Signal, CreateSignal } from './chamber';
import { createCommandBus } from './command-bus';
import type { CommandBus, Plugin, PluginOptions } from './command-bus';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FormRules<T extends Record<string, any>> = {
  [K in keyof T]?: (value: T[K], values: T) => string | null | Promise<string | null>;
};

export type FormBusOptions<T extends Record<string, any>> = {
  /** Initial field values — also used as the reset target. */
  fields: T;
  /** Per-field validation rules. Return a string on error, null on pass. */
  rules?: FormRules<T>;
  /** Called after successful validation on submit(). May be async. */
  onSubmit?: (values: T) => void | Promise<void>;
  /**
   * Create reactive signals for all form state (values, errors, isDirty, etc.).
   * Default: true. Set to false for headless / server-side / batch use cases
   * where reactivity is not needed — avoids 7 signal allocations per form.
   * When false, all Signal fields still work as plain get/set wrappers.
   */
  reactive?: boolean;
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
  /** True when either validating or submitting — use for disabling submit buttons. */
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
  /** The underlying command bus — for advanced use (DevTools, testing). */
  bus: CommandBus;
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
    if (!(key in values)) continue;
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
  for (const key in rules) {
    if (!(key in values)) continue;
    const rule = rules[key as keyof T];
    if (!rule) continue;
    const msg = await rule(values[key as keyof T], values);
    if (msg) errs[key as keyof T] = msg;
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
 * createFormBus — reactive form state manager built on the command bus.
 *
 * All form mutations go through the internal bus, so plugins (logger,
 * throttle, authGuard, etc.) intercept them like any other command.
 */
export function createFormBus<T extends Record<string, any>>(
  options: FormBusOptions<T>,
): FormBus<T> {
  const { onSubmit, reactive: useReactive = true } = options;
  const rules = (options.rules ?? {}) as FormRules<T>;
  const initial: T = { ...options.fields };

  const bus = createCommandBus();

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

  /** Update isBusy whenever isSubmitting or isValidating changes */
  function updateBusy(): void {
    isBusy.value = isSubmitting.value || isValidating.value;
  }

  // ---- formSet -----------------------------------------------------------
  bus.register('formSet', (cmd) => {
    const { field, value } = cmd.payload as { field: keyof T; value: T[keyof T] };
    const next = { ...values.value, [field]: value } as T;
    values.value  = next;
    const errs    = runRulesSync(rules, next);
    errors.value  = errs;
    isDirty.value = hasDiff(initial, next);
    isValid.value = Object.keys(errs).length === 0;
    return next;
  });

  // ---- formTouch ---------------------------------------------------------
  bus.register('formTouch', (cmd) => {
    const { field } = cmd.payload as { field: keyof T };
    touched.value = { ...touched.value, [field]: true };
    return touched.value;
  });

  // ---- formReset ---------------------------------------------------------
  bus.register('formReset', () => {
    values.value   = { ...initial };
    errors.value   = {};
    touched.value  = {};
    isDirty.value  = false;
    isValid.value  = true;
    isSubmitting.value = false;
    isValidating.value = false;
    isBusy.value   = false;
    return values.value;
  });

  // ---- formValidate (internal) ------------------------------------------
  bus.register('formValidate', () => {
    // Touch all fields so errors become visible
    const allTouched: Partial<Record<keyof T, boolean>> = {};
    for (const k in initial) allTouched[k as keyof T] = true;
    touched.value = allTouched;

    const errs   = runRulesSync(rules, values.value);
    errors.value = errs;
    isValid.value = Object.keys(errs).length === 0;
    return { valid: isValid.value, errors: errs };
  });

  // ---- Public API --------------------------------------------------------

  function set<K extends keyof T>(field: K, value: T[K]): void {
    bus.dispatch('formSet', {}, { field, value });
  }

  function touch<K extends keyof T>(field: K): void {
    bus.dispatch('formTouch', {}, { field });
  }

  function reset(): void {
    bus.dispatch('formReset', {});
  }

  async function submit(): Promise<boolean> {
    // Touch all fields so errors become visible
    const allTouched: Partial<Record<keyof T, boolean>> = {};
    for (const k in initial) allTouched[k as keyof T] = true;
    touched.value = allTouched;

    // Run all rules — awaits async validators too
    // Set isValidating so the UI can show loading state during async validation
    isValidating.value = true;
    updateBusy();
    try {
      const errs = await runRulesAsync(rules, values.value);
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
      if (onSubmit) await onSubmit(values.value);
      return true;
    } finally {
      isSubmitting.value = false;
      updateBusy();
    }
  }

  function use(plugin: Plugin, pluginOptions?: PluginOptions): void {
    bus.use(plugin, pluginOptions);
  }

  return { values, errors, touched, isDirty, isValid, isSubmitting, isValidating, isBusy, set, touch, submit, reset, use, bus };
}
