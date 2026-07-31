/**
 * vapor-chamber/router/vdom — the router's virtual-DOM render surface.
 *
 * Split out of `vapor-chamber/router` on purpose. `RouterOutlet` and
 * `makeBladeComponent` are built with `defineComponent` / `h` / `onMounted`,
 * so anything that can reach them statically pins Vue's vDOM runtime into the
 * consumer's bundle — including Vapor apps that never render either one.
 *
 * The subpath is named for what it costs, not for what it contains: importing
 * from here means you have opted into the vDOM runtime.
 *
 *   import { createRouter } from 'vapor-chamber/router';       // no vDOM
 *   import { RouterOutlet } from 'vapor-chamber/router/vdom';  // vDOM
 *
 * Blade rows do NOT need this import — the router loads `makeBladeComponent`
 * on demand the first time it renders one (see resolveRender in ./index).
 * It is re-exported here only for apps that wrap blade HTML themselves.
 */

export { RouterOutlet } from './outlet';
export { makeBladeComponent } from './blade';
export type { BladeHooks } from './blade';
