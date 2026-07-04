import { ref } from 'vue';
import { bus } from '../store';

// Pre-binds one action + tracks its error state. Named useAction to avoid
// shadowing the library's useCommand(), which takes no arguments and uses
// the shared bus.
//
// The sync bus never throws — missing handlers and handler exceptions come
// back as { ok: false, error } — so read the returned result instead of
// wrapping dispatch in try/catch.
export function useAction(action: string) {
  const error = ref<string | null>(null);

  function execute(target?: unknown, payload?: unknown) {
    error.value = null;
    const result = bus.dispatch(action, target, payload);
    if (!result.ok) error.value = result.error.message;
  }

  return { execute, error };
}
