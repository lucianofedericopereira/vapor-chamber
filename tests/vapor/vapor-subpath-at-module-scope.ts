/**
 * Helper for `vapor-subpath-wiring.test.ts` - NOT a test file (the vapor
 * project only collects `*.test.ts`).
 *
 * Its whole job is to observe the registry at MODULE-EVALUATION time. ESM
 * evaluates a module's dependencies before its own body, synchronously, so by
 * the time the line below runs, `src/vapor.ts`'s body has already executed its
 * `configureVue()` call - while any dynamic `import()` the runtime probe kicked
 * off is still pending, because a dynamic import cannot settle before the
 * current synchronous run-to-completion finishes.
 *
 * So a `true` here can only have come from the STATIC wiring. That is the
 * distinction the test needs and cannot get by awaiting an import from inside a
 * test body, where the probe has had every opportunity to resolve.
 */

import '../../src/vapor';
import { isVaporAvailable } from '../../src/chamber';

export const vaporReadyAtModuleScope: boolean = isVaporAvailable();
