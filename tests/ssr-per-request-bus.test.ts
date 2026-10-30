/**
 * Concurrent SSR renders with a bus per request never cross; a shared bus set per request loses the slower request.
 * Why: a server that sets the shared bus per request and resets it after would lose the dispatch of whichever concurrent render finishes last; a bus provided to each request's app and passed to the composable as `{ bus }` is safe.
 * Shows: two renders interleaved across an await each dispatch only their own id on their own bus; with the shared bus the slower request's dispatch is lost.
 * See: log s35.221, log s35.224, docs/whitepaper.md 12.2, src/ssr.ts
 */
import { afterEach, describe, expect, vi } from 'vitest';
import { createSSRApp, defineComponent, h, inject } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createCommandBus, resetCommandBus, setCommandBus, useCommand, type CommandBus } from '../src/index';
import { it } from '../src/vitest';

afterEach(() => {
  resetCommandBus();
  vi.restoreAllMocks();
});

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The ids a bus's `note` handler received. */
function notes(bus: CommandBus): string[] {
  const ids: string[] = [];
  bus.register('note', (cmd) => { ids.push(cmd.target); });
  return ids;
}

/** A page that reads its bus, awaits, then dispatches its request id from a composable. */
function page(id: string, wait: number, busOf: () => CommandBus | undefined) {
  return defineComponent({
    async setup() {
      // Read the bus before the await: a plain async setup does not restore the component instance after it, so inject must run first.
      const bus = busOf();
      await tick(wait);
      // Created after the await, when the shared bus may already have moved on.
      const { dispatch } = useCommand({ bus });
      dispatch('note', id);
      return () => h('p', id);
    },
  });
}

describe('concurrent SSR renders', () => {
  it('a bus per request, provided to its app and passed to the composable: no request crosses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    async function render(id: string, wait: number): Promise<string[]> {
      const bus = createCommandBus();
      const ids = notes(bus);
      const app = createSSRApp(page(id, wait, () => inject<CommandBus>('bus')));
      app.provide('bus', bus);
      await renderToString(app);
      return ids;
    }
    const [a, b] = await Promise.all([render('a', 20), render('b', 5)]);
    expect({ a, b }).toEqual({ a: ['a'], b: ['b'] });
  });

  it('control: the shared bus set per request loses the slower request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    async function render(id: string, wait: number): Promise<string[]> {
      const bus = createCommandBus();
      const ids = notes(bus);
      setCommandBus(bus);
      try {
        await renderToString(createSSRApp(page(id, wait, () => undefined)));
      } finally {
        resetCommandBus();
      }
      return ids;
    }
    const [a, b] = await Promise.all([render('a', 20), render('b', 5)]);
    // b sets the shared bus last and finishes first; its reset leaves a's composable a fresh shared bus with no `note` handler.
    expect({ a, b }).toEqual({ a: [], b: ['b'] });
  });
});
