// A4: a consumer with no vitest installed, importing the root and
// vapor-chamber/vite (which carries vaporChamberTest), typechecks clean
// without skipLibCheck. The augmentation (`declare module 'vitest'`) lives
// only in vapor-chamber/vitest's declarations, which this file never reaches.
import { createCommandBus } from 'vapor-chamber';
import { vaporChamberTest, vaporChamberWire } from 'vapor-chamber/vite';

export const plugins = [vaporChamberTest({ sharedBus: { exclude: ['tests/x.test.ts'] } }), vaporChamberWire()];
export const bus = createCommandBus();
