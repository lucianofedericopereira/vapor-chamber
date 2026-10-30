/**
 * A form's commands and history's `undoAction` / `redoAction` run locally under a '*' transport.
 * Why: they are the library's own state changes, so if the bus sent them to the server the form's
 * state would never change and history would never press undo, with no signal. The library declares
 * them local once, at its own registration (`_asLibrary`), and an app action under '*' is still sent.
 * Shows: form set/touch/setErrors/submit/reset and history undo/redo change local state and post
 * nothing, the test bus behaves the same, and once the library registration ends (dispose or
 * `bus.clear()`) an app handler of that name is sent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createFormBus } from '../src/form';
import { history } from '../src/plugins-core';
import { createTestBus } from '../src/testing';
import { httpTransport } from '../src/transports';

afterEach(() => { vi.unstubAllGlobals(); });

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A server that records each command it gets and fails it with 503. */
function failingServer() {
  const posted: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    posted.push(JSON.parse(init.body).command);
    return { ok: false, status: 503, headers: new Headers(), text: async () => 'down' };
  }));
  return posted;
}

const everything = () => ({ '*': httpTransport({ endpoint: '/api/vc' }) });

describe("a '*' transport and the library's own commands", () => {
  it('CONTROL: an app action under * is sent', async () => {
    const posted = failingServer();
    const bus = createAsyncCommandBus({ retry: false, transport: everything() });
    const r = await bus.dispatch('cartAdd', { id: 1 });
    expect(r.ok).toBe(false);
    expect(posted).toEqual(['cartAdd']);
  });

  it("a form's five commands change the form and send nothing", async () => {
    const posted = failingServer();
    const bus = createAsyncCommandBus({ retry: false, transport: everything() });
    const form = createFormBus({ bus: bus as any, fields: { name: '' }, rules: { name: (v: string) => (v ? null : 'Required') } });
    form.set('name', 'Ada');
    form.touch('name');
    await settle();
    expect(form.values.value).toEqual({ name: 'Ada' });
    expect(form.touched.value).toEqual({ name: true });
    form.setErrors([{ pointer: '/payload/name', detail: 'Taken' }]);
    await settle();
    expect(form.errors.value).toEqual({ name: 'Taken' });
    form.set('name', '');
    expect(await form.submit()).toBe(false);
    expect(form.errors.value).toEqual({ name: 'Required' });
    form.reset();
    await settle();
    expect(form.values.value).toEqual({ name: '' });
    expect(posted).toEqual([]);
    form.dispose();
  });

  it("history's undoAction and redoAction run here and send nothing", async () => {
    const posted = failingServer();
    const bus = createAsyncCommandBus({ retry: false, transport: everything() });
    const h = history({ bus, undoAction: 'historyUndo', redoAction: 'historyRedo' });
    expect((await bus.dispatch('historyUndo', null)).ok).toBe(true);
    expect((await bus.dispatch('historyRedo', null)).ok).toBe(true);
    expect(posted).toEqual([]);
    h.dispose();
  });

  it('the test bus keeps them local by the same rule', async () => {
    const posted = failingServer();
    const bus = createTestBus({ transport: everything(), passthroughHandlers: true });
    const form = createFormBus({ bus: bus as any, fields: { name: '' } });
    form.set('name', 'Ada');
    await settle();
    expect(form.values.value).toEqual({ name: 'Ada' });
    expect(posted).toEqual([]);
    form.dispose();
  });

  it('the library registration ends with its cleanup: an app handler of that name afterwards is sent', async () => {
    const posted = failingServer();
    const bus = createAsyncCommandBus({ retry: false, transport: everything() });
    const h = history({ bus, undoAction: 'historyUndo' });
    h.dispose();
    await bus.dispatch('historyUndo', null);
    expect(posted).toEqual(['historyUndo']);
  });

  it('bus.clear() ends it too', async () => {
    const posted = failingServer();
    const bus = createAsyncCommandBus({ retry: false, transport: everything() });
    history({ bus, undoAction: 'historyUndo' });
    bus.clear();
    await bus.dispatch('historyUndo', null);
    expect(posted).toEqual(['historyUndo']);
  });
});
