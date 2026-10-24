/**
 * vapor-chamber - the IIFE variants' one builder: `createApp` and `connect`,
 * the same in every variant, so one call site works whichever bundle loads.
 */

import {
  createAsyncCommandBus,
  type AsyncCommandBusOptions,
  type PluginParts,
  type CommandBusOptions,
} from './command-bus';
import { httpTransport, type HttpTransportOptions } from './transports';

export type CreateAppOptions = {
  /** The bus's transport: one, or a map by action pattern (`createAsyncCommandBus({ transport })`). */
  transport?: AsyncCommandBusOptions['transport'];
  /** Plugins to install on the bus. */
  plugins?: PluginParts[];
  /** Dead-letter mode. Default: 'error' */
  onMissing?: CommandBusOptions['onMissing'];
  /** Hold a dispatch until its handler registers (`createBuffer`). */
  buffer?: CommandBusOptions['buffer'];
  /** The bus's retry, on by default. `{ actionPolicies: { cartAdd: 'idempotent' } }` declares a policy, `false` turns it off. */
  retry?: AsyncCommandBusOptions['retry'];
};

/**
 * createApp - a configured async bus: its transport, retry and plugins.
 *
 * @example
 * const { bus, dispatch } = VaporChamber.createApp({
 *   transport: VaporChamber.httpTransport({ endpoint: '/api/vc' })
 * })
 * dispatch('cartAdd', { id: 1 }, { quantity: 2 })
 */
export function createApp(options: CreateAppOptions = {}): {
  bus: ReturnType<typeof createAsyncCommandBus>;
  dispatch: ReturnType<typeof createAsyncCommandBus>['dispatch'];
} {
  const bus = createAsyncCommandBus({ onMissing: options.onMissing ?? 'error', retry: options.retry, transport: options.transport, buffer: options.buffer });
  if (options.plugins) for (const p of options.plugins) bus.use(p);
  return { bus, dispatch: bus.dispatch };
}

/**
 * connect - one-line setup for the sprinkled-JS audience: HTTP with CSRF.
 *
 * Equivalent to:
 *   createApp({ transport: httpTransport({ endpoint, csrf: true, ...rest }) })
 *
 * @example
 * <script>
 *   const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc' });
 *   document.getElementById('add').addEventListener('click', () => {
 *     dispatch('cartAdd', { id: 42 });
 *   });
 * </script>
 */
export function connect(options: HttpTransportOptions & Omit<CreateAppOptions, 'transport'>): ReturnType<typeof createApp> {
  const { plugins, onMissing, retry, buffer, ...httpOptions } = options;
  return createApp({ transport: httpTransport({ csrf: true, ...httpOptions }), plugins, onMissing, retry, buffer });
}
