/**
 * vapor-chamber - Built-in plugins
 *
 * Re-exports the core and I/O plugins. The extras (plugins-extra) ship from
 * the root entry, not from here:
 *  - plugins-core: logger, validator, history, debounce, throttle, authGuard, optimistic, optimisticUndo
 *  - plugins-io:   persist, createChannel
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
  persist,
  createChannel,
  type PersistOptions,
  type PersistStorage,
  type ChannelOptions,
} from './plugins-io';
