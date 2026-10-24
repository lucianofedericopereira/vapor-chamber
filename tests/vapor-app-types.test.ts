// A Vapor app from `vapor-chamber/vapor` is typed, and its directive() takes the Vapor directives; rationale at the end.
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

  // Control: Vue's own createVaporApp still takes no Vapor directive (Vue's type, rc.12).
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

/*
 * The documented app-wide registration, `createVaporApp(App).directive(
 * 'vc-command', vcCommandVapor)`, failed tsc with TS2345: Vue's App.directive
 * takes `Directive` only, and a Vapor directive's second parameter is a getter,
 * not a binding (B4 b, log 36.F42). An augmentation of Vue's App would reach a
 * classic app too, where Vue calls a function as `(el, binding)` and the
 * directive throws. So the Vapor app type lives where Vue's types may be named,
 * `vapor-chamber/vapor`: Vue's App<ParentNode> with one more directive()
 * overload. It extends the interface, so `this` stays the Vapor app after
 * use(). The root cannot name a Vue type, so there it could only be `any`, and
 * it no longer exports createVaporChamberApp.
 */
