# 10. Testing

This chapter tests an app's commands. The Vitest integration, with matchers, fixtures, stubs and
an MCP server for agents, is [integrations/vitest.md](../integrations/vitest.md).

## Assert on dispatches

On Vitest 5, `setupFiles: ['vapor-chamber/vitest']` tests the real bus with matchers such as
`expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 1 })`. See
[docs/integrations/vitest.md](../integrations/vitest.md).

`createTestBus()` records every dispatched command without running real handlers.

```typescript
import { createTestBus, setCommandBus, resetCommandBus } from 'vapor-chamber';

beforeEach(() => { bus = createTestBus(); setCommandBus(bus); });
afterEach(()  => { resetCommandBus(); });

it('dispatches cartAdd on click', () => {
  expect(bus.wasDispatched('cartAdd')).toBe(true);
  expect(bus.getDispatched('cartAdd')[0].cmd.payload).toEqual({ quantity: 1 });
});
```

## Replay a command sequence

```typescript
const snap = bus.snapshot();          // RecordedDispatch[], a deep copy: editing it changes no record
bus.travelTo(1);                      // commands 0..1 inclusive
bus.travelToAction('cartAdd');        // up to last occurrence
bus.travelTo(999);                    // out-of-range indices clamp
```

## Test a Vapor component

A test that mounts a Vapor component needs two settings in `vitest.config.ts`. A production build
needs neither ([5. Vue](./05-vue.md)).

```typescript vapor-alias
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [{ find: /^vue$/, replacement: 'vue/dist/vue.runtime-with-vapor.esm-browser.js' }],
  },
  test: {
    environment: 'happy-dom',
    server: { deps: { inline: ['vapor-chamber'] } },
  },
});
```

- **The alias gives a bare `vue` Vapor.** Under Vitest a bare `vue` resolves to a build without it,
  and `createVaporApp` is `undefined`.
- **Keep the regex.** `/^vue$/` matches only the bare name, so a `vue/dist/...` import still reaches
  its file.
- **`inline` puts vapor-chamber on the same Vue.** Without it the library in `node_modules` loads
  its own `vue`, past the alias. The app and the library are then two disconnected reactivity
  instances, and `useRouter()` throws `no router provided` under a router that is installed.
- **Alias to this file, not to `vue.runtime.esm-bundler.js`.** Under Vitest on Vue 3.6.0-rc.14 that
  entry throws `createInternalObject is not a function` at load.[^vapor-alias]

[^vapor-alias]: The block above runs as written in a packed, installed project, with a control for
    each setting: `tests/vapor-alias-consumer.test.ts`.

Next: [11. Laravel](./11-laravel.md).
