/**
 * vapor-chamber — Built-in plugins
 *
 * Re-exports all plugins from split modules:
 *  - plugins-core: logger, validator, history, debounce, throttle, authGuard, optimistic, optimisticUndo
 *  - plugins-io:   retry, persist, sync
 */

export {
  logger,
  validator,
  history,
  debounce,
  throttle,
  authGuard,
  optimistic,
  optimisticUndo,
  type HistoryState,
  type OptimisticUndoOptions,
} from './plugins-core';

export {
  retry,
  persist,
  sync,
  type RetryOptions,
  type PersistOptions,
  type SyncOptions,
} from './plugins-io';
