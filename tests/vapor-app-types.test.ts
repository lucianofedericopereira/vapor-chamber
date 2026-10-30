/**
 * A Vapor app from `vapor-chamber/vapor` is typed as Vue's App<ParentNode> plus a directive() overload that takes Vapor directives, and the root does not export it.
 * Why: Vue's App.directive takes Directive only, so the documented app-wide registration of a Vapor directive would fail tsc; an augmentation of Vue's App would reach classic apps, where a Vapor directive throws, so the type lives on the subpath.
 * Shows: the runtime test asserts only that appTypes and createVaporChamberApp are functions and that the root has no createVaporChamberApp; the type assertions in appTypes (never called) are checked by tsc -p tsconfig.tests.json.
 * See: log s36.F42
 */
import { describe, expect, expectTypeOf } from 'vitest';
import { createVaporApp, type App, type Plugin, type VaporDirective } from 'vue';
import * as root from '../src/index';
import { vcCommandVapor, vcOptimisticVapor, vcPayloadVapor } from '../src/directives';
import { createVaporChamberApp, defineVaporComponent, type VaporChamberApp } from '../src/vapor';
import { it } from '../src/vitest';

declare const plugin: Plugin;

// Never called. tsconfig.tests.json type-checks it; at runtime it is only defined.
function appTypes(): void {
  const Root = defineVaporComponent({ setup: () => document.createElement('i') });
  const app = createVaporChamberApp(Root);
  expectTypeOf(app).toEqualTypeOf<VaporChamberApp>();
  expectTypeOf(app).toMatchTypeOf<App<ParentNode>>();

  // The app-wide registration of each Vapor directive, and chained after use().
  app.directive('vc-command', vcCommandVapor);
  app.directive('vc-payload', vcPayloadVapor);
  app.directive('vc-optimistic', vcOptimisticVapor);
  expectTypeOf(app.use(plugin).directive('vc-command', vcCommandVapor)).toEqualTypeOf<VaporChamberApp>();
  expectTypeOf(app.directive('vc-command', vcCommandVapor).mount).toEqualTypeOf<App<ParentNode>['mount']>();

  // @ts-expect-error a Vapor app is no number: the result is not `any`.
  const n: number = createVaporChamberApp(Root);
  void n;

  // Control: the directive is Vue's own Vapor shape.
  const v: VaporDirective = vcCommandVapor;
  void v;

  // Control: Vue's own createVaporApp takes no Vapor directive.
  // @ts-expect-error App.directive takes Directive only
  createVaporApp(Root).directive('vc-command', vcCommandVapor);
}

describe('createVaporChamberApp', () => {
  it('is defined on vapor-chamber/vapor and no longer on the root', () => {
    expect(typeof appTypes).toBe('function');
    expect(typeof createVaporChamberApp).toBe('function');
    expect('createVaporChamberApp' in root).toBe(false);
  });
});
