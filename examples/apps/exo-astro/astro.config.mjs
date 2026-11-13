import { defineConfig } from 'astro/config';

// Static HTML out, zero framework runtime - the only client JS is the bus,
// the two stores in src/store.ts and the page bindings.
export default defineConfig({
  server: { port: 8890 },
});
