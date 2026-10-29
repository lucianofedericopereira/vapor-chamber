# 2. Commands, results and failures

This chapter covers what every app does on the bus: register a handler, dispatch, read the
result, listen, and handle a failure. The design behind it is in the
[whitepaper](../whitepaper.md), sections 3 and 4.

## Anatomy of a command

A command has three parts: an **action** (what to do), a **target** (what to act on) and an
optional **payload**.

```typescript
bus.dispatch('cartAdd', product, { quantity: 2 });
```

Every dispatch returns `{ ok: boolean, value?: any, error?: Error }`.

## Register a handler

One handler per action. The newest registration is live, and when it is unregistered, the one
it covered answers again. A handler returns a value or throws:

```typescript
bus.register('cartAdd', (cmd) => {
  cart.items.push(cmd.target);
  return cart.items;    // becomes result.value
});

// with undo support
bus.register('cartAdd', addHandler, {
  undo: (cmd) => { cart.items.pop(); },
});
```

## Enforce a naming convention

Check names at register and dispatch time:

```typescript
const bus = createCommandBus({
  naming: { pattern: /^[a-z][a-zA-Z0-9]+$/, onViolation: 'throw' },  // or 'warn' / 'ignore'
});
bus.register('cartAdd', handler);    // ok
bus.register('cart_add', handler);   // throws
```

A name that contains `$` belongs to the library (a store's `cart$reset`) and is not checked
against the pattern. The case for camelCase is the whitepaper's section 3.5.

## Listen, read and emit

```typescript
bus.on('*', (cmd, result) => analytics.track(cmd.action));   // all commands
bus.on('cart*', (cmd, result) => console.log(cmd.action));   // prefix
bus.once('cartAdd', () => showConfetti());                   // fires once
bus.offAll('cart*');                                         // remove by pattern
bus.offAll();                                                // remove all

// Auto-unsubscribe on abort - matches DOM addEventListener semantics
bus.on('cartAdd', trackAdd, { signal: controller.signal });

// Every unsubscribe fn also carries Symbol.dispose, for `using`
{
  using off = bus.once('checkout', showConfetti);
} // unsubscribed automatically at scope exit
```

**Read with `query()`.** A query is a read. The command state does not count it as pending, and
its rules, steps and `onAfter` hooks still run. This is the CQRS split: `dispatch()` writes,
`query()` reads.

```typescript
bus.register('getUser', (cmd) => db.users.find(cmd.target.id));
const result = bus.query('getUser', { id: 42 });
```

**Announce with `emit()`.** It fires a domain event: it notifies `on()` listeners, needs no
handler and returns no result.

```typescript
bus.on('orderCreated', (cmd) => analytics.track('order', cmd.target));
bus.emit('orderCreated', { orderId: 42, total: 99.50 });
```

## Read a command's metadata

The bus stamps every dispatched command with `meta`:

```typescript
bus.onAfter((cmd) => {
  cmd.meta.id;              // unique per dispatch (counter-based, UUID through configureUid)
  cmd.meta.ts;              // Date.now(), read once per microtask turn
  cmd.meta.correlationId;   // trace ID for command chains
});

bus.dispatch('orderShip', order, {
  __correlationId: originalCommand.meta.id,
  __causationId:   originalCommand.meta.id,
});
```

- History reads `causationId`. A command that a handler dispatches with its parent's id is
  undone with the parent, and a redo of the parent applies it once.
- A command's `action`, `target`, `payload` and `meta` are `readonly` in its type. Every part,
  listener and history entry reads the one command, so build a new value instead of writing to
  it. The meta's own fields stay writable.
- Every timestamp the library produces, and its form, is listed in
  [timestamps.md](../timestamps.md).

## Handle a failure

Every failure a dispatch or a transport returns is a `BusError`, with two exceptions: a
handler's own throw and an `Error` given as the abort reason come back as themselves. A
`BusError`'s code is `owner:condition:subject`: who raised it, what went wrong and what it is
about. The bus sets the owner, never the raiser.

```typescript
import { BusError, conditionOf, ownerOf } from 'vapor-chamber';

const result = bus.dispatch('missing', {});
if (!result.ok && result.error instanceof BusError) {
  result.error.code;          // 'core:missing:handler'
  ownerOf(result.error);      // 'core'
  conditionOf(result.error);  // 'missing'
  result.error.context;       // what the message carries (e.g. retryIn on every `limited` refusal)
}
```

- A plugin's failures carry its declared `id` as the owner (`rateLimit:limited:action`,
  `circuitBreaker:limited:action`).
- A backend's problem is `remote:<condition of its status>:<its code>`, inside a 2xx
  `{ problem }` too.
- A status maps to one condition: 404/410 `missing`, 409/412 `conflict`, 401/419
  `unauthenticated`, 403 `refused`, 429/503 `limited`, 408/504 `timeout`. The conditions read one
  to one against gRPC's canonical codes ([contract.md](../contract.md) 3).
- `ERROR_CODE_REGISTRY` is the full table, with fix suggestions. Production messages state the
  fact and leave the fix to the registry. [errors.md](../errors.md) lists every code.
- Match a failure on its `code`, never on its `message`: a development build's message says
  more than a production one.

`<id>:failed:plugin` means a plugin's part threw or rejected. `cause` is the original and
`context.part` the part (`validate`, `admit`, ...). Every built-in plugin declares its id
(`cache:failed:plugin`). A transport that throws reads `transport:failed:send`, like its other
failures. A plugin of yours with no id reads `plugin:failed:plugin`. It is a bug in the
pipeline, not a failing server: the bus does not re-run it, and `circuitBreaker` neither counts
it nor resets on it.

### What the async bus re-sends

- It re-sends a transient failure (`limited`, a 408 `timeout`) for any action.
- It re-sends an uncertain one (no reply, a 502 or 504, a 500) only for an action declared
  idempotent or a keyed command.
- A declared `retryIn` sets the wait, never whether to wait.
- It never re-sends an unidentified command that got no reply. That one fails with
  `context.outcome: 'unknown'`, since it may have landed.

Never re-sent:

- a verdict (`invalid`, `refused`, `missing`, `already`, `conflict`), unless identified and
  answered with a wait
- an expired session (`unauthenticated`: sign in, then dispatch again)
- an abort, a depth bound or a plugin's own throw

To configure it, see [chapter 3](./03-plugins.md#configure-the-async-buss-retry). The full rule
is [retry.md](../retry.md).

### Route the library's own reports

What the library detects and goes on from (a listener's throw, a misuse in development) is a
report with its code. One formatter prints it, and every sink receives it. The default prints an
aligned level tag (`[ WARN ]` or `[ FAIL ]`), the code and the message. In development it adds a
link to the code's section, which gives its fix (`getErrorEntry(code).fix` reads it too):

```text
[vapor-chamber] [ FAIL ] core:failed:listener: a listener threw on "cartAdd"
  docs: https://github.com/lucianofedericopereira/vapor-chamber/blob/main/docs/errors.md#failed
```

```typescript
import { configureReport, consoleSink } from 'vapor-chamber';
configureReport({ sinks: [consoleSink, (r) => telemetry.send(r.code, r.context)] });
configureReport({ format: (r) => [`${r.level} ${r.code} ${r.message}`] });
configureReport({ level: 'error' }); // warnings dropped; 'silent' drops both
configureReport(null); // the default formatter, the console, level 'warn'
```

## Inspect a bus

`inspectBus()` returns a topology snapshot. It is tree-shakeable and not bundled unless
imported:

```typescript
const info = inspectBus(bus);
info.actions;          // ['cartAdd', 'cartRemove', ...]
info.undoActions;      // actions with registered undo handlers
info.pluginCount;      // 3
info.plugins;          // [{ id: 'logger', actions: undefined, actionFilter: false, parts: ['settled'] }, ...] in install order
info.sealed;           // false
info.dispatchDepth;    // 0 (increments during nested dispatch)
```

## Dispatch a batch

```typescript
const result = bus.dispatchBatch([
  { action: 'cartAdd',      target: cart, payload: item },
  { action: 'totalsUpdate', target: cart },
]);
// stops at first failure by default

bus.dispatchBatch(commands, { continueOnError: true });
// result.successCount / result.failCount / result.results
```

`transactional: true` runs all or nothing. On failure, the commands that already succeeded roll
back through their registered undo handlers:

```typescript
bus.register('paymentCharge', chargeHandler, { undo: refundHandler });

const result = bus.dispatchBatch([
  { action: 'inventoryReserve', target: item },
  { action: 'paymentCharge',    target: payment },
], { transactional: true });

if (!result.ok) console.log('Rollbacks:', result.rollbacks);
```

## Decide what a missing handler does

`onMissing` sets what happens when no handler is registered:

```typescript
createCommandBus()                                // default: { ok: false, error }
createCommandBus({ onMissing: 'throw' })
createCommandBus({ onMissing: 'ignore' })         // { ok: true, value: undefined }
createCommandBus({ onMissing: (cmd) => { ... } })   // custom fallback
```

**Hold a command until its handler registers** with a buffer. It is built for lazy wiring: an
island or a code-split panel whose handler arrives after the first click.

```typescript
import { Accepted, createBuffer, createCommandBus } from 'vapor-chamber';

const buffer = createBuffer({ ttl: 30_000 });
const bus = createCommandBus({ buffer });

const r = bus.dispatch('cartAdd', item);                // before the island hydrates
if (r.value instanceof Accepted) await r.value.done;    // the handler's result, once it runs
buffer.pending.value;                                   // how many commands wait, all actions
```

- A held dispatch answers `{ ok: true, value }`, with `value` an `Accepted`. Its `done` settles
  with the handler's result once the command runs through the whole chain.
- Only an action with no handler, no responder and no transport is held. A query never waits.
- `maxSize` (256 per action by default) drops the oldest past it, and its `done` settles with
  `buffer:exceeded:queue`. `ttl` (ms, no limit by default) drops an older command with
  `buffer:timeout:queue`.
- `onDrop(action, { target, payload })` hears each dropped command.[^buffer]

[^buffer]: `tests/buffer-on-bus.test.ts`.

## Go async

The async bus awaits handlers and plugins, which HTTP and other I/O need:

```typescript
import { createAsyncCommandBus } from 'vapor-chamber';

const bus = createAsyncCommandBus();
bus.register('userFetch', async (cmd) => (await fetch(`/api/users/${cmd.target.id}`)).json());
const result = await bus.dispatch('userFetch', { id: 123 });
```

**Request and response**, with a timeout. With no responder registered, it falls back to a plain
`dispatch()`:

```typescript
bus.respond('getAuthToken', async () => (await fetch('/api/token')).json());
const result = await bus.request('getAuthToken', { userId: 42 }, undefined, { timeout: 3000 });
```

**Cancel a dispatch** by passing an `AbortSignal` as the fourth argument. What each kind of abort
returns is in [performance.md](../performance.md), "`dispatch(..., { signal })`".

## Describe the bus to a language model

Schemas for LLM system prompts, so a model does not invent methods or error codes:

```typescript
import { describeErrorCodes, busApiSchema, getErrorEntry } from 'vapor-chamber';

const errorTable = describeErrorCodes();
const apiSchema  = busApiSchema();
getErrorEntry('core:missing:handler')?.fix;   // "Register a handler with bus.register(action, handler) before dispatching."
```

## Let a language model call your commands

A schema bus turns its actions into tools ([chapter 1](./01-getting-started.md) defines the
schema). The library calls no model provider itself:

```typescript
const bus = createSchemaCommandBus(schema);

bus.toTools('anthropic');   // or 'openai': one tool per action, target and payload kept apart
bus.describe();             // a plain-text list of the commands, for a system prompt

// A tool_use block the app already has:
bus.fromToolCall({ name: 'cartAdd', input: { target: { id: 5 }, payload: { qty: 2 } } });

// Or text in, a dispatch out, through your own adapter:
await bus.synthesize('add 2 of item 5', {
  adapter: async (tools, text) => {
    const res = await anthropic.messages.create({ model, max_tokens: 1024, tools, messages: [{ role: 'user', content: text }] });
    const toolUse = res.content.find((b) => b.type === 'tool_use');
    return { name: toolUse.name, input: toolUse.input };
  },
});
```

`synthesize` needs its `adapter`. Without one it returns `schema:missing:adapter` and sends
nothing.

**Serve the bus over MCP.** `vapor-chamber/mcp` makes each schema action an MCP tool. A
`tools/call` dispatches the call's `{ target, payload }` through the bus:

```typescript
import { createActionFilter } from 'vapor-chamber';
import { createMcpHandler, serveMcpStdio } from 'vapor-chamber/mcp';

const cart = createActionFilter([{ prefix: { action: 'cart' } }]);

// Any transport: one JSON-RPC message in, the reply out (null for a notification).
const handle = createMcpHandler(bus, { actionFilter: cart });
const reply = await handle(message);

// Or a Node process an MCP client starts:
const dispose = serveMcpStdio(bus, { actionFilter: cart });
process.on('SIGTERM', dispose);
```

- **Allowlist.** An MCP client is an LLM-driven caller. `actionFilter` lists what it may call.
  Without one every action is a tool, writes included, and development builds warn.
- **Results.** A failed command is a tool result with `isError: true`, not a protocol error. A
  tool not listed answers `-32602`.
- **Origin.** Every dispatch an MCP call makes carries `meta.origin: 'agent'`.
- **Stdio limits.** `maxLineLength` (1 MiB) drops a line with no end, and `maxInFlight` (32)
  pauses input while that many calls run. Replies go out as each call completes, matched by
  `id`. Log to stderr while serving: stdout carries the protocol.
- **Tests.** `vc.mcp` drives a handler as an agent does
  ([integrations/vitest.md](../integrations/vitest.md)).

Next: [3. Plugins](./03-plugins.md).
