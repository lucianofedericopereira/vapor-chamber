/**
 * vapor-chamber - Vue Vapor integration
 *
 * Note: Vue Vapor is still in development. This integration uses
 * the expected signal-based API. Update imports when Vapor stabilizes.
 */

import { createCommandBus, type CommandBus, type Command, type CommandResult, type Handler, type Plugin } from './command-bus';

// Vapor's signal API (expected shape - adjust when Vapor releases)
// For now, we'll use a shim that works with both Vapor and standard Vue
type Signal<T> = { value: T };
type CreateSignal = <T>(initial: T) => Signal<T>;

// Detect environment and get signal function
function getSignalFn(): CreateSignal {
  // Try Vapor's signal first (when available)
  // @ts-ignore - Vapor not yet typed
  if (typeof window !== 'undefined' && window.__VUE_VAPOR__?.signal) {
    // @ts-ignore
    return window.__VUE_VAPOR__.signal;
  }

  // Fallback: simple signal implementation for testing/non-Vapor
  return <T>(initial: T): Signal<T> => {
    let _value = initial;
    const listeners: Array<(v: T) => void> = [];

    return {
      get value() { return _value; },
      set value(v: T) {
        _value = v;
        listeners.forEach(fn => fn(v));
      }
    };
  };
}

const signal = getSignalFn();

/**
 * Shared command bus instance
 */
let sharedBus: CommandBus | null = null;

export function getCommandBus(): CommandBus {
  if (!sharedBus) {
    sharedBus = createCommandBus();
  }
  return sharedBus;
}

export function setCommandBus(bus: CommandBus): void {
  sharedBus = bus;
}

/**
 * useCommand - dispatch commands with reactive loading/error state
 */
export function useCommand() {
  const bus = getCommandBus();
  const loading = signal(false);
  const lastError = signal<Error | null>(null);

  function dispatch(action: string, target: any, payload?: any): CommandResult {
    loading.value = true;
    lastError.value = null;

    const result = bus.dispatch(action, target, payload);

    loading.value = false;
    if (!result.ok) {
      lastError.value = result.error ?? null;
    }

    return result;
  }

  return {
    dispatch,
    loading,
    lastError,
    register: bus.register,
    use: bus.use,
  };
}

/**
 * useCommandState - create reactive state that updates via commands
 */
export function useCommandState<T>(
  initial: T,
  handlers: {
    [action: string]: (state: T, cmd: Command) => T;
  }
) {
  const bus = getCommandBus();
  const state = signal(initial);

  // Register handlers that update state
  const unregisters: Array<() => void> = [];

  for (const [action, handler] of Object.entries(handlers)) {
    const unregister = bus.register(action, (cmd) => {
      state.value = handler(state.value, cmd);
      return state.value;
    });
    unregisters.push(unregister);
  }

  // Cleanup function
  const dispose = () => {
    unregisters.forEach(fn => fn());
  };

  return { state, dispose };
}

/**
 * useCommandHistory - undo/redo with reactive state
 */
export function useCommandHistory(options: {
  maxSize?: number;
  filter?: (cmd: Command) => boolean;
} = {}) {
  const { maxSize = 50, filter } = options;
  const bus = getCommandBus();

  const past = signal<Command[]>([]);
  const future = signal<Command[]>([]);
  const canUndo = signal(false);
  const canRedo = signal(false);

  // Track commands via afterHook
  const unsubscribe = bus.onAfter((cmd, result) => {
    if (result.ok && (!filter || filter(cmd))) {
      const newPast = [...past.value, cmd];
      if (newPast.length > maxSize) newPast.shift();
      past.value = newPast;
      future.value = [];
      canUndo.value = true;
      canRedo.value = false;
    }
  });

  function undo(): Command | undefined {
    const p = [...past.value];
    const cmd = p.pop();
    if (cmd) {
      past.value = p;
      future.value = [...future.value, cmd];
      canUndo.value = p.length > 0;
      canRedo.value = true;
    }
    return cmd;
  }

  function redo(): Command | undefined {
    const f = [...future.value];
    const cmd = f.pop();
    if (cmd) {
      future.value = f;
      past.value = [...past.value, cmd];
      canUndo.value = true;
      canRedo.value = f.length > 0;
    }
    return cmd;
  }

  function clear() {
    past.value = [];
    future.value = [];
    canUndo.value = false;
    canRedo.value = false;
  }

  return {
    past,
    future,
    canUndo,
    canRedo,
    undo,
    redo,
    clear,
    dispose: unsubscribe,
  };
}
