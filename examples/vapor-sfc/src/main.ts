/**
 * Bootstrap a pure Vapor app. `createVaporChamberApp` is the lib's wrapper
 * around Vue 3.6's `createVaporApp` — same shape as `createApp`, but the
 * resulting tree skips the VDOM and uses Vapor's compiler-emitted DOM ops.
 */
import { createVaporChamberApp } from 'vapor-chamber';
import App from './App.vue';

createVaporChamberApp(App).mount('#app');
