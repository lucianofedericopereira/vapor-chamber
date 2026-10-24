/**
 * vapor-chamber - Built-in plugins
 *
 * Re-exports the core and I/O plugins. The extras (plugins-extra) ship from
 * the root entry, not from here:
 *  - plugins-core: logger, validator, history, authGuard
 *  - plugins-io:   createChannel
 */

export {
  logger,
  validator,
  history,
  authGuard,
  type HistoryState,
} from './plugins-core';

export {
  createChannel,
  type ChannelOptions,
} from './plugins-io';
