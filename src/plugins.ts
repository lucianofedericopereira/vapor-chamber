/**
 * vapor-chamber - Built-in plugins
 *
 * Re-exports all plugins from split modules:
 *  - plugins-core: logger, validator, history, debounce, throttle, authGuard, optimistic, optimisticUndo
 *  - plugins-io:   retry, persist, createChannel
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
  createChannel,
  type RetryOptions,
  type PersistOptions,
  type ChannelOptions,
} from './plugins-io';
