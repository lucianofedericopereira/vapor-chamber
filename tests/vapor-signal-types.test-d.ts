// From `vapor-chamber/vapor`, a signal is typed as the Vue ShallowRef it is at run time, so a template unwraps it with no cast.
import type { ShallowRef } from 'vue';
import { commandState, createCommandBus, signal, useCommand, useSharedCommandState, useVaporAsyncCommand } from '../src/vapor';

export const count: ShallowRef<number> = signal(1);
export const adding: Readonly<ShallowRef<boolean>> = useCommand().pending('cartAdd' as never);
export const any: Readonly<ShallowRef<boolean>> = useSharedCommandState().anyPending;
export const creating: Readonly<ShallowRef<boolean>> = useVaporAsyncCommand().pending('orderCreate');
export const neutral: Readonly<ShallowRef<boolean>> = commandState(createCommandBus()).pending('cartAdd');
// The value reads as before.
export const n: number = signal(2).value;
