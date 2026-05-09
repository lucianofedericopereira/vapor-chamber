import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { vaporChamberHMR } from 'vapor-chamber/vite';

// Minimal Vite config for the Vapor SFC example.
//
// `@vitejs/plugin-vue` ≥ 5.x detects `<script setup vapor>` blocks and routes
// them to `@vue/compiler-vapor` automatically — no extra config needed.
//
// `vaporChamberHMR()` preserves the bus (handlers, plugins, hooks, listeners)
// across hot module replacement so app state survives component reloads.

export default defineConfig({
  plugins: [
    vue(),
    vaporChamberHMR({ verbose: false }),
  ],
});
