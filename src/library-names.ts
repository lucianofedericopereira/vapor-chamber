/**
 * vapor-chamber - the library's own command names.
 *
 * A name with `$` is the library's (`<id>$reset`, `<action>$undo`): an app
 * registering one is refused, the bridges and the outbox keep such a command
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

/** @internal Inside `_asLibrary`. */
export const _isLibraryRegister = (): boolean => libraryRegister;
