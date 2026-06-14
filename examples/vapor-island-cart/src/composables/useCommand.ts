import { ref } from 'vue';
import { bus } from '../store';

// Wraps bus.dispatch with error state. Dispatch is synchronous so no loading flag.
export function useCommand(action: string) {
  const error = ref<string | null>(null);

  function execute(target?: unknown, payload?: unknown) {
    error.value = null;
    try { bus.dispatch(action, target, payload); }
    catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  }

  return { execute, error };
}
