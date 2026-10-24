/**
 * vapor-chamber - the library's own command names.
 *
 * A name with `$` is the library's (`<id>$reset`, `<action>$undo`): an app
 * registering one is refused, the bus and the outbox keep such a command
 * local. Its own module so the store reaches it without importing the bus.
 * Log s35.114, s35.117.
 */

/** @internal A `$` name marks a handler the library registered: handled locally, never sent or queued (no backend contract defines it). */
export const _isLibraryAction = (action: string): boolean => action.includes('$');

let libraryRegister = false;

/** @internal Register one of the library's own `$` commands: `fn` is the register() call. */
export function _asLibrary<T>(fn: () => T): T {
  libraryRegister = true;
  try { return fn(); } finally { libraryRegister = false; }
}

/** @internal `_asLibrary` for one register() call, with no closure to build: a store's `$reset` per creation. */
export function _registerAsLibrary<O>(bus: { register(action: string, handler: any, options?: O): () => void }, action: string, handler: unknown, options?: O): () => void {
  libraryRegister = true;
  try { return bus.register(action, handler, options); } finally { libraryRegister = false; }
}

/** @internal Inside `_asLibrary`. */
export const _isLibraryRegister = (): boolean => libraryRegister;

let localRegister = false;

/**
 * @internal Register the library's own command under a name the app chose (a
 * form's `<id>Set`, history's `undoAction`): local under any transport, on
 * either bus. The name is still the app's, so a `$` in it is refused.
 * tests/library-commands-under-transport.test.ts.
 */
export function _registerLocal<H>(bus: { register(action: string, handler: H): () => void }, action: string, handler: H): () => void {
  localRegister = true;
  try { return bus.register(action, handler); } finally { localRegister = false; }
}

/** @internal Inside `_registerLocal`. */
export const _registersLocal = (): boolean => localRegister;
