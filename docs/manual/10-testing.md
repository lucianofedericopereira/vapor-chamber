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

Next: [11. Laravel](./11-laravel.md).
