import { createBatchingHttpBridge, createHttpBridge } from '../src/transports';

// Compile-time check (log s35.124): `csrf` is a boolean. `'inertia'` sent no
// token at all (the bridge's own fetch, which no Axios interceptor touches);
// an Inertia app on Laravel uses `csrf: true`, which reads the XSRF-TOKEN cookie.
createHttpBridge({ endpoint: '/api/vc', csrf: true });
createBatchingHttpBridge({ endpoint: '/api/vc/batch', csrf: false });
// @ts-expect-error - 'inertia' is no longer an option
createHttpBridge({ endpoint: '/api/vc', csrf: 'inertia' });
// @ts-expect-error - nor on the batching bridge
createBatchingHttpBridge({ endpoint: '/api/vc/batch', csrf: 'inertia' });
