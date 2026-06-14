import { defineConfig } from 'astro/config';

// Static HTML out, zero framework runtime — the only client JS is the bus
// and the ~150-line directive scanner in src/directives/index.ts.
export default defineConfig({
  server: { port: 8890 },
});
