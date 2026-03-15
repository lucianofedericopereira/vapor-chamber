/**
 * vapor-chamber - Lightweight command bus for Vue Vapor
 *
 * ~2KB gzipped (core + plugins + composables). DevTools loaded dynamically.
 */

// Core
export {
  createCommandBus,
  createAsyncCommandBus,
  type Command,
  type CommandResult,
  type CommandBus,
  type AsyncCommandBus,
  type Handler,
  type AsyncHandler,
  type Plugin,
  type AsyncPlugin,
  type Hook,
  type AsyncHook,
} from './command-bus';

// Plugins
export {
  logger,
  validator,
  history,
  debounce,
  throttle,
  type HistoryState,
} from './plugins';

// Vapor integration
export {
  signal,
  configureSignal,
  type Signal,
  type CreateSignal,
  getCommandBus,
  setCommandBus,
  useCommand,
  useCommandState,
  useCommandHistory,
} from './chamber';

// DevTools integration (optional — requires @vue/devtools-api)
export { setupDevtools } from './devtools';
