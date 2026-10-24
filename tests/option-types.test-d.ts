// The option and store types an app writes against: mutable action lists, a read-only declared list, an extendable store options type, schema keys as written.
import type { CacheOptions, CircuitBreakerOptions, IdempotentOptions, MetricsOptions, RateLimitOptions, SupersedeOptions } from '../src/plugins-extra';
import type { OutboxOptions } from '../src/outbox';
import type { ChamberStore, ChamberStoreOptions, StoreReducer } from '../src/store-base';
import type { PluginParts } from '../src/command-bus';
import { pace } from '../src/pace';
import { useCommand, useCommandError, useCommandHistory } from '../src/chamber';
import { history, logger } from '../src/plugins-core';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { createSchemaCommandBus } from '../src/schema';

// An app keeps its plugin options in a typed variable and edits the list.
type Mutable = { actions?: string[] };
declare const cacheO: CacheOptions;
declare const cbO: CircuitBreakerOptions;
declare const rlO: RateLimitOptions;
declare const mO: MetricsOptions;
declare const iO: IdempotentOptions;
declare const suO: SupersedeOptions;
declare const oO: OutboxOptions;
export const asMutable: Mutable[] = [cacheO, cbO, rlO, mO, iO, suO, oO];
export function edit(o: CacheOptions): void { o.actions?.push('more*'); }

// A plugin's declared list reads as a `readonly string[]`.
export const declared: readonly string[] | undefined = ({} as PluginParts).actions;

// An app types its store options, reads the map back, and extends the options
// with its own fields (an interface needs an object type).
type S = { n: number };
type R = { set: StoreReducer<S> };
export function mapOf(o: ChamberStoreOptions<S, R>): R { return o.reducers; }
export interface LabelledStoreOptions extends ChamberStoreOptions<S, R> { label: string }
export type Store = ChamberStore<S, R>;

// Pacing is the sender's: one of the two options, and a paced dispatch is a promise.
const syncBus = createCommandBus();
export const paced: Promise<unknown> = pace(syncBus.dispatch, { debounce: 10 })('save');
// @ts-expect-error one of the two, never both
pace(syncBus.dispatch, { debounce: 10, throttle: 10 });
export const typed: Promise<unknown> = useCommand({ bus: syncBus, throttle: 10 }).dispatch('save' as never, undefined as never);
// @ts-expect-error register has no throttle option: pacing left the bus
syncBus.register('save', () => 1, { throttle: 10 });

// A schema key in any style types its camelCase name, the one it validates (s35.175).
const schemaBus = createSchemaCommandBus({ cart_add: { target: { id: 'number' } } });
schemaBus.register('cartAdd', () => 1);
export const camelKey = schemaBus.dispatch('cartAdd', { id: 1 });
// @ts-expect-error the key as written is not a typed name
schemaBus.dispatch('cart_add', { id: 1 });

// The action's optimistic and exclusive, on either bus (step 4k, the homes of
// optimisticUndo, s35.177, and serialize).
const asyncBus = createAsyncCommandBus();
asyncBus.register('cartAdd', async () => 1, { undo: () => {}, optimistic: true, exclusive: { key: (cmd) => cmd.target.id, scope: 'cross-tab', lockPrefix: 'app' } });
createCommandBus().register('cartAdd', () => 1, { undo: () => {}, optimistic: true, exclusive: {} });
// @ts-expect-error a scope the option does not name
asyncBus.register('cartPay', async () => 1, { exclusive: { scope: 'tabs' } });

// One scope for the logger and the recorders (step 7c): `actions` and `actionFilter`, and no `filter(cmd)`.
const scopeBus = createCommandBus();
export const scoped = [
  logger({ actions: ['cart*'], actionFilter: (a) => a !== 'cartClear' }),
  history({ bus: scopeBus, actions: ['cart*'], actionFilter: (a) => a !== 'cartClear' }),
  useCommandHistory({ actions: ['cart*'] }),
  useCommandError({ actionFilter: (a) => a.startsWith('cart') }),
];
// @ts-expect-error the predicate of a whole command is gone
logger({ filter: (cmd) => cmd.action === 'cartAdd' });
// @ts-expect-error likewise
history({ bus: scopeBus, filter: (cmd) => cmd.action === 'cartAdd' });
// @ts-expect-error likewise
useCommandHistory({ filter: (cmd) => cmd.action === 'cartAdd' });
// @ts-expect-error likewise
useCommandError({ filter: (cmd) => cmd.action === 'cartAdd' });
