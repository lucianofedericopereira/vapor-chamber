/** `outbox.clear()` while a record is being sent: its caller hears the send, and a record held after stays. The long note is at the end. */
import { describe, expect, it } from 'vitest';
import type { Accepted } from '../src/accepted';
import { createAsyncCommandBus } from '../src/command-bus';
import { createOutbox } from '../src/outbox';
import { defineTransport } from '../src/transports';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('outbox.clear() during a flush', () => {
  it('the record in flight settles with its send, and one held after the clear stays held', async () => {
    let online = false;
    const release: Array<() => void> = [];
    const sent: string[] = [];
    const t = defineTransport(async (cmd: { action: string }) => {
      sent.push(cmd.action);
      await new Promise<void>((r) => release.push(r));
      return { ok: true, value: `sent ${cmd.action}` };
    });
    const outbox = createOutbox({ storage: null, isOnline: () => online, autoFlush: false });
    const bus = createAsyncCommandBus({ retry: false, transport: t, outbox } as never);
    const a = await bus.dispatch('a', 1);
    online = true;
    const flushing = outbox.flush();
    await tick();
    await outbox.clear();
    online = false;
    const b = await bus.dispatch('b', 2);
    expect(outbox.pending.value).toBe(1);
    release[0]?.();
    await flushing;
    expect(await (a.value as Accepted).done).toMatchObject({ ok: true, value: 'sent a' });
    expect(outbox.pending.value).toBe(1);
    online = true;
    const second = outbox.flush();
    await tick();
    release[1]?.();
    await second;
    expect(sent).toEqual(['a', 'b']);
    expect(await (b.value as Accepted).done).toMatchObject({ ok: true, value: 'sent b' });
  });
});

/*
 * Found in step 4j (log 36.74), probed on c3f28d2 (the released shape since 9d835c3). The
 * flush shifted the queue's head after each send without checking it was still the record it
 * sent. A `clear()` during the send settled that caller with `outbox:aborted:clear`, though
 * the command had gone out, and the record held after the clear was then shifted away by the
 * landing send: never sent, its `done` never settled, `pending` 0. Now the record in flight is
 * not settled by `clear()` or its ttl; the flush settles it with its send's answer and leaves
 * the queue's new head alone.
 */
