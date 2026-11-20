// @vitest-environment happy-dom
/**
 * One report for a setup error that crosses a Vapor component boundary.
 * Why: rc.16 handles an error once when a nested Vapor call (a child's setup or render, run inside its parent's) has already reported it and rethrown it (vuejs/core#16315). Before rc.16 the same error reached Vue's error path twice, so a dev page printed it twice and a user errorHandler was called twice.
 * Shows: a child whose setup throws produces one "Unhandled error during execution of setup function" report; the control, the same component as the app root, produces one on both releases.
 * See: vuejs/core#16315, vuejs/core#16338, whitepaper 15
 */

import { describe, expect, it } from 'vitest';
import { type VaporApi, compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

async function vapor(): Promise<VaporApi> {
  return (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
}

/** Mount `Boom`, at the root or as a child of a compiled root; return the reports Vue made. */
async function mountThrowingChild(where: 'root' | 'child'): Promise<string[]> {
  const v = await vapor();
  const reports: string[] = [];
  const warn = console.warn;
  const error = console.error;
  const capture = (...args: unknown[]) => {
    reports.push(args.map(String).join(' '));
  };
  console.warn = capture;
  console.error = capture;
  try {
    const Boom = v.defineVaporComponent({
      setup() {
        throw new Error('boom');
      },
    });
    const tpl = where === 'child' ? await compileVapor(v, '<Boom />') : null;
    const Root =
      tpl !== null ? v.defineVaporComponent({ setup: () => tpl.render({ Boom }) }) : Boom;
    const host = document.createElement('div');
    document.body.append(host);
    const app = v.createVaporApp(Root);
    if (where === 'child') app.component('Boom', Boom);
    try {
      app.mount(host);
    } catch {
      // whether the mount throws is not the claim
    }
    await v.nextTick();
    host.remove();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return reports.filter((r) => r.includes('Unhandled error') || r.includes('boom'));
}

describe('a Vapor setup error is reported once', () => {
  it('a child whose setup throws: one report', async () => {
    expect(await mountThrowingChild('child')).toHaveLength(1);
  });

  it('control: the same component at the root: one report', async () => {
    expect(await mountThrowingChild('root')).toHaveLength(1);
  });
});
