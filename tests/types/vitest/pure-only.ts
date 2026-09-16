// A4: importing vapor-chamber/vitest/pure alone registers no matcher, so it
// must not type one. Compiled with `types: []`, so nothing else augments vitest.
import { expect } from 'vitest';
import { createCommandBus } from 'vapor-chamber';
import { tap } from 'vapor-chamber/vitest/pure';

const bus = tap(createCommandBus());
// @ts-expect-error no matcher is typed by the pure entry
expect(bus).toHaveBeenDispatched('cartAdd');

// The stubs return a Disposable whose [Symbol.dispose] member a consumer lib
// without esnext.disposable does not know (TS2550 unless the declaration
// carries its ignore directive). This file compiles with types: [] and an ES2022 lib.
import { stubEnv, stubGlobal } from 'vapor-chamber/vitest/pure';

export const restoreGlobal = stubGlobal('fetch', undefined);
export const restoreEnv = stubEnv('NODE_ENV', 'production');
