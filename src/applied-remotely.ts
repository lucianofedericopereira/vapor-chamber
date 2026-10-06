/**
 * vapor-chamber - the commands a transport carried out.
 *
 * Its own module so the store reaches it without importing the bus, as
 * library-names.ts is (log s35.184).
 */

/**
 * @internal The commands a bridge carried out, each with the store states its
 * reply declared (`stores`, by store id), when any: the server applied the
 * command and the local handler never ran. History reads it when it undoes,
 * the bus when it hands a handler the answer and the stores their states
 * (`RegisterOptions.answer`), a store's rebase when it replays; never per
 * dispatch. A map rather than a field, so a command keeps its shape.
 * tests/undo-remote-step.test.ts (log s35.159), tests/store-declared-by-server.test.ts.
 */
export const _appliedRemotely = /* @__PURE__ */ new WeakMap<object, Record<string, unknown> | undefined>();

/**
 * @internal Per async bus: store id -> what writes a state a server's reply
 * declared for that store (`stores`). The bus reads it at a transport's level;
 * a store adds itself and removes only itself. A Map, so an id from the wire
 * never reads an inherited name (src/dict.ts).
 */
export const _storeReceivers = /* @__PURE__ */ new WeakMap<object, Map<string, (cmd: { action: string; target: any; payload?: any }, value: unknown) => void>>();
