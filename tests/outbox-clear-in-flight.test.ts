/**
 * `outbox.clear()` while a record is being sent.
 * Why: if clear() settled the in-flight record as aborted, its caller would hear a drop for a command that went out, and the landing send would shift away a record held after the clear, so it is never sent.
 * Shows: the in-flight record settles with its send's answer, the record held after the clear stays pending and is sent by the next flush.
 * See: log s36.74
 */
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
