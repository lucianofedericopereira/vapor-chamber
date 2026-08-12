import { ref } from 'vue';
import { untracked } from 'vapor-chamber';
import { bus } from '../store';

// Pre-binds one action + tracks its error state. Named useAction to avoid
// shadowing the library's useCommand(), which takes no arguments and uses
// the shared bus.
//
// The sync bus never throws — missing handlers and handler exceptions come
// back as { ok: false, error } — so read the returned result instead of
// wrapping dispatch in try/catch.
//
// NOTE the `untracked()` wrapper, which is the point of this file as an
// example. The library's own composables (useCommand, useCommandGroup,
// useSharedCommandState, useCommandQuery) do this for you. This composable
// talks to a RAW bus, so it has to do it itself:
//
// A dispatch is an action, not a read. Without untracked(), any reactive value
// the HANDLER happens to read gets collected as a dependency of whatever effect
// called execute() — so a component would re-render on state it never mentions,
// silently. Today every call site here is a click handler, where there is no
// active effect and untracked() costs nothing; it is written this way so the
// pattern stays correct if someone later calls execute() from a watchEffect or
// a computed. It is also a plain pass-through when Vue is absent.
export function useAction(action: string) {
  const error = ref<string | null>(null);

  function execute(target?: unknown, payload?: unknown) {
    error.value = null;
    const result = untracked(() => bus.dispatch(action, target, payload));
    if (!result.ok) error.value = result.error.message;
  }

  return { execute, error };
}
