import type { ShallowRef } from 'vue';

/**
 * vapor-chamber's `Signal<T>` is `{ value: T }` — deliberately **Vue-free** (the core
 * has no Vue dependency). In a Vue/Vapor app the signals ARE real `shallowRef`s at
 * runtime, so Vapor auto-unwraps them in templates (`{{ loading }}`, not `loading.value`).
 *
 * `asRef` re-types a signal as the `ShallowRef` it already is, so **vue-tsc** auto-unwraps
 * it in `<template>` too — matching runtime instead of erroring on `Signal<T>`. The cast is
 * runtime-honest (the value genuinely carries the ref brand once Vue is present); the
 * `as unknown` is only needed because the Vue-free static type can't express that.
 *
 * Drop these once the typed `vapor-chamber/vapor` surface (v2.0 roadmap) lands.
 */
export const asRef = <T>(signal: { value: T }): ShallowRef<T> => signal as unknown as ShallowRef<T>;
