// Ambient stubs for `examples/tsconfig.patterns.json`.
//
// The pattern-*/feature-*/etc. files are copy-paste snippets that illustrate
// importing from files/packages a REAL consuming project would have (a Vue
// SFC, the Inertia adapter, @vitejs/plugin-vue) but that intentionally don't
// exist in this repo. These declarations exist so the type-check stays
// focused on its actual goal — catching misuse of vapor-chamber's OWN
// exported API (the reason this file exists at all:
// pattern-6-vapor-router.ts called `createHttpBridge({ bus, ... })` as if
// `bus` were a config option, when it's a plugin you pass to `bus.use()` —
// not on whether an illustrative import target happens to exist in this repo.
declare module '*.vue';
declare module '@inertiajs/vue3';
declare module '@vitejs/plugin-vue';
