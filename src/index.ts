/**
 * vapor-chamber - Lightweight command bus for Vue Vapor
 *
 * A ~1KB command bus with plugins, hooks, and Vapor-native reactivity.
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
  getCommandBus,
  setCommandBus,
  useCommand,
  useCommandState,
  useCommandHistory,
} from './chamber';
