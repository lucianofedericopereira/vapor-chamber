// Code that compiles against the 1.26 release must compile against this source (log s35.151); renamed names excepted (log s35.156).
import type { CacheOptions, CircuitBreakerOptions, IdempotentOptions, MetricsOptions, RateLimitOptions, SerializeOptions, SupersedeOptions } from '../src/plugins-extra';
import type { HttpBridgeOptions, WsBridgeOptions } from '../src/transports';
import type { OutboxOptions } from '../src/outbox';
import type { PollWithOptions } from '../src/poll-with';
import type { ChamberStore, ChamberStoreOptions, StoreReducer } from '../src/store-base';
import type { PluginParts } from '../src/command-bus';
import { debounce, optimisticUndo, throttle } from '../src/plugins-core';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { createSchemaCommandBus } from '../src/schema';

// An app keeps its plugin options in a typed variable and edits the list.
type Mutable = { actions?: string[] };
declare const cacheO: CacheOptions;
declare const cbO: CircuitBreakerOptions;
declare const rlO: RateLimitOptions;
declare const mO: MetricsOptions;
declare const sO: SerializeOptions;
declare const iO: IdempotentOptions;
declare const suO: SupersedeOptions;
declare const hO: HttpBridgeOptions;
declare const wO: WsBridgeOptions;
declare const oO: OutboxOptions;
declare const pO: PollWithOptions;
export const asMutable: Mutable[] = [cacheO, cbO, rlO, mO, sO, iO, suO, hO, wO, oO, pO];
export function edit(o: CacheOptions): void { o.actions?.push('more*'); }

// A plugin's declared list reads as 1.26's `readonly string[]`.
export const declared: readonly string[] | undefined = ({} as PluginParts).actions;

// An app types its store options, reads the map back, and extends the options
// with its own fields (an interface needs an object type).
type S = { n: number };
type R = { set: StoreReducer<S> };
export function mapOf(o: ChamberStoreOptions<S, R>): R { return o.reducers; }
export interface LabelledStoreOptions extends ChamberStoreOptions<S, R> { label: string }
export type Store = ChamberStore<S, R>;

// The required lists, as before.
const bus = createCommandBus();
export const lists = [debounce(['save'], 10), throttle(['save'], 10), optimisticUndo(bus, ['save'])];

// A schema key as written, in any style, types its register and dispatch (s35.175).
const schemaBus = createSchemaCommandBus({ cart_add: { target: { id: 'number' } } });
schemaBus.register('cart_add', () => 1);
export const rawKey = schemaBus.dispatch('cart_add', { id: 1 });

// optimisticUndo on an async bus, as its own JSDoc example does (s35.177).
const asyncBus = createAsyncCommandBus();
asyncBus.use(optimisticUndo(asyncBus, ['cartAdd']));
