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
  type PluginOptions,
  type BatchCommand,
  type BatchResult,
  type DeadLetterMode,
  type CommandBusOptions,
  type NamingConvention,
  type RegisterOptions,
  type Listener,
} from './command-bus';

// Testing utilities
export { createTestBus, type TestBus, type RecordedDispatch } from './testing';

// Plugins
export {
  logger,
  validator,
  history,
  debounce,
  throttle,
  authGuard,
  optimistic,
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
  resetCommandBus,
  useCommandBus,
  useCommand,
  useCommandState,
  useCommandHistory,
  // v0.4.0: Vue 3.6 Vapor alignment
  isVaporAvailable,
  createVaporChamberApp,
  getVaporInteropPlugin,
  defineVaporCommand,
} from './chamber';

// DevTools integration (optional — requires @vue/devtools-api)
export { setupDevtools } from './devtools';
