import { httpTransport } from '../src/transports';

// Compile-time check (log s35.124): `csrf` is a boolean. `'inertia'` sent no
// token at all (the transport's own fetch, which no Axios interceptor touches);
// an Inertia app on Laravel uses `csrf: true`, which reads the XSRF-TOKEN cookie.
httpTransport({ endpoint: '/api/vc', csrf: true });
httpTransport({ endpoint: '/api/vc/batch', csrf: false, batch: {} });
// @ts-expect-error - 'inertia' is no longer an option
httpTransport({ endpoint: '/api/vc', csrf: 'inertia' });
// @ts-expect-error - nor with batch
httpTransport({ endpoint: '/api/vc/batch', csrf: 'inertia', batch: {} });
