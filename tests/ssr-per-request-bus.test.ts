// Concurrent SSR renders with a bus per request never cross; rationale at the end.
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
      const bus = busOf();
      await tick(wait);
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
    // b set the shared bus last and finished first; its reset left nothing for
    // a, whose composable then got a fresh shared bus with no `note` handler.
    expect({ a, b }).toEqual({ a: [], b: ['b'] });
  });
});

/*
 * Why this file exists. src/ssr.ts and whitepaper 12.2 showed a server entry
 * that sets the shared bus per request and resets it after. Their own warning
 * says that is unsafe under concurrent renders. The control measures it: two
 * renders interleaved across an `await` in setup, and the slower request's
 * dispatch is lost. The first test is the shape the docs now show: a bus per
 * request, provided to that request's app, read by the component and passed to
 * the composable as `{ bus }` (log s35.221, s35.224). No dispatch crosses.
 *
 * The bus is read before the `await`. A plain async setup does not restore the
 * component instance after an await, so `inject` must run first. A compiled
 * `<script setup>` restores it. The composable is created after the await, the
 * case where the shared bus has already moved on.
 */
