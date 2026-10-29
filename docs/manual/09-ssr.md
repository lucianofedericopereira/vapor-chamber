# 9. Server rendering

This chapter renders a Vue app on the server with a bus, and hands the stores' states to the
client. The reasons behind each rule are in the [whitepaper](../whitepaper.md), section 12.

## Give each request its own bus and HTTP client

Create both per request. A component reads the bus and passes it to each composable:

```ts
import { createSSRApp, inject } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createCommandBus, createHttpClient, useCommand } from 'vapor-chamber/vue'

export async function handleRequest(req, res) {
  const bus = createCommandBus()
  const http = createHttpClient({ headers: { cookie: req.headers.cookie } })
  const app = createSSRApp(App)
  app.provide('bus', bus)
  // pass `http` explicitly - createRouter({ http }), whose loaders read through it, or fetchLoaders({ http })
  res.end(await renderToString(app))
}

// in a component's setup
const { dispatch } = useCommand({ bus: inject('bus') })
```

- Never share one bus across concurrent renders. Interleaved renders lose or swap each other's
  dispatches.
- Never share one HTTP client either. Its cache and in-flight dedupe would serve one user's data
  to another, when users differ by anything but a request header. Or leave `cache` off on the
  server.

## Hand the stores' states to the client

On the server, after rendering:

```ts
// server-entry.ts, per request
import { storeStates, serializeForScript } from 'vapor-chamber/ssr'

// ... render the app on this request's bus ...
const html = await renderToString(app)
const states = storeStates(bus)      // { cart: {...}, user: {...} }, by store id
// embed: <script>window.__VAPOR_STATES__ = ${serializeForScript(states)}</script>
```

On the client, before mounting:

```ts
// client-entry.ts
import { seedStores } from 'vapor-chamber/ssr'

seedStores(getCommandBus(), window.__VAPOR_STATES__)
createVaporChamberApp(App).mount('#app')
```

- `serializeForScript` escapes the JSON so user text cannot close the `<script>` element.
- Nothing replays: the client ends on the server's state, a reducer that minted an id included.
- A store created after `seedStores` starts from its seeded state. On a fresh page the server's
  state wins over a saved one.
- Route data stays the router's.

Next: [10. Testing](./10-testing.md).
