/**
 * createSseBridge: a second install() replaces the stream. The first one was
 * left open, out of dispose()'s reach, and kept delivering to its bus.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { createSseBridge } from '../src/transports';

class FakeEventSource {
  static OPEN = 1;
  static made: FakeEventSource[] = [];
  readyState = 1;
  closed = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeEventSource.made.push(this); }
  close() { this.closed = true; }
}

afterEach(() => { vi.unstubAllGlobals(); FakeEventSource.made = []; });

describe('createSseBridge - install twice', () => {
  it('closes the first stream, and dispose() closes the second', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const bridge = createSseBridge({ url: '/events', onEvent: () => {} });
    bridge.install(createCommandBus());
    bridge.install(createCommandBus());
    const [first, second] = FakeEventSource.made;
    expect(first!.closed).toBe(true);
    bridge.dispose();
    expect(second!.closed).toBe(true);
  });
});
