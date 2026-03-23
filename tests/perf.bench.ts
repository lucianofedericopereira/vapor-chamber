/**
 * vapor-chamber — Performance benchmarks
 *
 * Run with: npx vitest bench tests/perf.bench.ts
 * Or:       npm run test -- --bench tests/perf.bench.ts
 *
 * These are not CI tests — they measure throughput on the developer's machine.
 */

import { describe, it, expect, bench } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/command-bus';

describe('core dispatch throughput', () => {
  bench('syncDispatch — bare handler, no plugins', () => {
    const bus = createCommandBus();
    bus.register('test', (cmd) => cmd.target);
    for (let i = 0; i < 10_000; i++) {
      bus.dispatch('test', i);
    }
  });

  bench('syncDispatch — 3 plugins + 1 listener', () => {
    const bus = createCommandBus();
    bus.use((cmd, next) => next());
    bus.use((cmd, next) => next());
    bus.use((cmd, next) => next());
    bus.on('*', () => {});
    bus.register('test', (cmd) => cmd.target);
    for (let i = 0; i < 10_000; i++) {
      bus.dispatch('test', i);
    }
  });

  bench('syncQuery — bare handler, no plugins', () => {
    const bus = createCommandBus();
    bus.register('getUser', (cmd) => ({ id: cmd.target }));
    for (let i = 0; i < 10_000; i++) {
      bus.query('getUser', i);
    }
  });

  bench('emit — 3 listeners, no handler', () => {
    const bus = createCommandBus();
    bus.on('test', () => {});
    bus.on('test', () => {});
    bus.on('test', () => {});
    for (let i = 0; i < 10_000; i++) {
      bus.emit('test', i);
    }
  });

  bench('matchesPattern — wildcard prefix*', () => {
    const bus = createCommandBus();
    bus.on('cart*', () => {});
    bus.register('cartAdd', () => {});
    for (let i = 0; i < 10_000; i++) {
      bus.dispatch('cartAdd', i);
    }
  });

  bench('dispatchBatch — 100 commands', () => {
    const bus = createCommandBus();
    bus.register('test', () => 'ok');
    const cmds = Array.from({ length: 100 }, (_, i) => ({ action: 'test', target: i }));
    for (let i = 0; i < 100; i++) {
      bus.dispatchBatch(cmds);
    }
  });
});

describe('meta overhead', () => {
  bench('dispatch with crypto.randomUUID (if available)', () => {
    const bus = createCommandBus();
    bus.register('test', () => {});
    for (let i = 0; i < 10_000; i++) {
      bus.dispatch('test', i);
    }
  });
});

describe('async dispatch throughput', () => {
  bench('asyncDispatch — bare handler', async () => {
    const bus = createAsyncCommandBus();
    bus.register('test', async (cmd) => cmd.target);
    for (let i = 0; i < 1_000; i++) {
      await bus.dispatch('test', i);
    }
  });
});

// Functional perf sanity test (always runs, not just in bench mode)
describe('performance sanity', () => {
  it('10k sync dispatches complete under 200ms', () => {
    const bus = createCommandBus();
    bus.register('test', (cmd) => cmd.target);
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      bus.dispatch('test', i);
    }
    const elapsed = performance.now() - start;
    console.log(`  10k sync dispatches: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(200);
  });

  it('10k queries complete under 200ms', () => {
    const bus = createCommandBus();
    bus.register('test', (cmd) => cmd.target);
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      bus.query('test', i);
    }
    const elapsed = performance.now() - start;
    console.log(`  10k sync queries:    ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(200);
  });

  it('10k emits complete under 100ms', () => {
    const bus = createCommandBus();
    bus.on('test', () => {});
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      bus.emit('test', i);
    }
    const elapsed = performance.now() - start;
    console.log(`  10k emits:           ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(100);
  });

  it('command.meta.id is populated', () => {
    const bus = createCommandBus();
    let meta: any;
    bus.register('test', (cmd) => { meta = cmd.meta; });
    bus.dispatch('test', {});
    expect(meta).toBeDefined();
    expect(typeof meta.id).toBe('string');
    expect(meta.id.length).toBeGreaterThan(0);
  });
});
