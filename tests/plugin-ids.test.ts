/**
 * The id every bus-plugin factory declares, against one fixed list.
 * Why: the id is the owner part of every failure code the plugin mints (`<id>:condition:subject`), so a changed id changes a code on the wire.
 * Shows: each factory declares its listed id, ids are one camelCase word, a throwing plugin or transport is reported under its owner, the error registry answers for any plugin throw, and every exported plugin factory in src is on the list.
 * See: log s35.77.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAsyncCommandBus, createCommandBus, type BusError } from '../src/command-bus';
import { authGuard, logger, validator } from '../src/plugins-core';
import { cache, circuitBreaker, idempotent, metrics, rateLimit, supersede } from '../src/plugins-extra';
import { validateSchemas, validateSchemasAsync } from '../src/plugins-schema';
import { schemaLogger, schemaValidator } from '../src/schema';
import { getErrorEntry, isRetryableCode } from '../src/error-registry';
import { httpTransport } from '../src/transports';

/** Factory name -> the id it declares. Changing an entry changes a failure code on the wire. */
const IDS: Record<string, string> = {
  logger: 'logger',
  validator: 'validator',
  authGuard: 'authGuard',
  cache: 'cache',
  circuitBreaker: 'circuitBreaker',
  rateLimit: 'rateLimit',
  metrics: 'metrics',
  idempotent: 'idempotent',
  supersede: 'supersede',
  validateSchemas: 'validateSchemas',
  validateSchemasAsync: 'validateSchemas',
  schemaValidator: 'schemaValidator',
  schemaLogger: 'schemaLogger',
};

const timed: Array<{ dispose(): void }> = [];
/** One instance of each, read for its plugin's id. */
const BUILT: Record<string, () => { id?: string }> = {
  logger: () => logger(),
  validator: () => validator({}),
  authGuard: () => authGuard({ isAuthenticated: () => true, protected: [] }),
  cache: () => cache(),
  circuitBreaker: () => circuitBreaker(),
  rateLimit: () => rateLimit(),
  metrics: () => metrics(),
  idempotent: () => idempotent(),
  supersede: () => supersede(),
  validateSchemas: () => validateSchemas({}),
  validateSchemasAsync: () => validateSchemasAsync({}),
  schemaValidator: () => schemaValidator({}),
  schemaLogger: () => schemaLogger({}),
};

describe('plugin ids', () => {
  it('every factory declares the id its entry says', () => {
    const got: Record<string, string | undefined> = {};
    for (const name of Object.keys(IDS)) got[name] = BUILT[name]().id;
    for (const t of timed) t.dispose();
    expect(got).toEqual(IDS);
  });

  it('an id is one owner word: camelCase, no colon', () => {
    for (const id of Object.values(IDS)) expect(id).toMatch(/^[a-z][a-zA-Z]*$/);
  });

  it('a plugin that throws is reported under its own id', () => {
    const bus = createCommandBus();
    bus.register('t', () => 1);
    bus.use(cache({ key: () => { throw new Error('boom'); } }));
    const r = bus.dispatch('t', 1);
    expect((r.error as BusError).code).toBe('cache:failed:plugin');
  });

  it('a transport that throws is reported as transport, like its other failures', async () => {
    const httpClient = { post: async () => ({ ok: true, status: 200, headers: {}, data: { state: 1 } }) } as never;
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', httpClient }) });
    // A lone surrogate as the idempotency key makes encodeURIComponent throw inside the transport.
    bus.use({ started: (cmd) => { cmd.meta!.idempotencyKey = '\uD800'; } });
    const r = await bus.dispatch('t', 1);
    expect((r.error as BusError).code).toBe('transport:failed:send');
  });

  it('the error registry answers for a plugin throw whatever its id', () => {
    const generic = getErrorEntry('plugin:failed:plugin');
    expect(generic).toBeDefined();
    for (const id of new Set(Object.values(IDS))) {
      expect(getErrorEntry(`${id}:failed:plugin`)).toBe(generic);
      expect(isRetryableCode(`${id}:failed:plugin`)).toBe(false);
    }
    // Only the throw: another code of a plugin is looked up as itself.
    expect(getErrorEntry('cache:invalid:payload')).toBeUndefined();
  });

  it('the list covers every exported plugin factory in src', () => {
    // A factory whose return type names Plugin / AsyncPlugin / SyncPlugin / PluginParts.
    const root = resolve(__dirname, '../src');
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('testing.ts')) {
          const text = readFileSync(p, 'utf8');
          for (const m of text.matchAll(/^export function (\w+)(?:<[^>]*>)?\(/gm)) {
            const close = text.slice(m.index).search(/\)\s*:\s*/);
            const sig = text.slice(m.index + close, m.index + close + 80);
            if (/^\)\s*:\s*(?:(?:Async|Sync)?Plugin|PluginParts)\b/.test(sig)) found.add(m[1]);
          }
        }
      }
    };
    walk(root);
    expect([...found].sort()).toEqual(Object.keys(IDS).sort());
  });
});
