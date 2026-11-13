// The app's one bus, its server and its cart.
//
// The server is a stand-in that lives in the page: an HTTP client whose `post`
// answers the wire contract (docs/contract.md 4) after a delay. Drop the
// `httpClient` option and `httpTransport` posts to a real `/api/vc`, with
// nothing else here changing.
//
// The cart is a store the server writes. `add: null` says the reducer is the
// server's, and `answer` turns each reply into the store's next state, so the
// panels read `cart.state` and keep no copy by hand.
import {
  createAsyncCommandBus,
  httpTransport,
  setCommandBus,
  type HttpClient,
  type HttpResponse,
} from 'vapor-chamber/vapor';
import { defineChamberStore } from 'vapor-chamber/store';

export type Product = { id: number; name: string; cents: number };
export type Cart = { count: number; total: number; lastAddedId: number | null };

const catalogue: readonly Product[] = [
  { id: 1, name: 'Wireless Headphones', cents: 1999 },
  { id: 2, name: 'Wireless Mouse', cents: 1499 },
  { id: 3, name: 'Wireless Keyboard', cents: 2999 },
  { id: 4, name: 'USB Cable', cents: 599 },
  { id: 5, name: 'USB Hub', cents: 2499 },
  { id: 6, name: 'Laptop Stand', cents: 3499 },
];

const STOCK = 10;
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

// The server's own cart: it accumulates across commands, so the page's totals
// move only with what the server confirmed.
const held = { count: 0, cents: 0 };

type Envelope = { command: string; target?: { id?: number }; payload?: unknown };

// One literal for every response (docs/V8-RULES.md rule 1).
const reply = (status: number, data: unknown): HttpResponse =>
  ({ ok: status < 300, status, data, headers: {}, url: undefined, redirected: undefined, stale: undefined });
const problem = (status: number, code: string, detail: string) => reply(status, { status, code, detail });

async function answer(body: Envelope): Promise<HttpResponse> {
  await wait(body.command === 'productSearch' ? 200 : 250);
  if (body.command === 'productSearch') {
    const term = String(body.payload).toLowerCase();
    const found: Product[] = [];
    for (const p of catalogue) if (p.name.toLowerCase().includes(term)) found.push(p);
    return reply(200, { state: found });
  }
  let product: Product | undefined;
  for (const p of catalogue) if (p.id === body.target?.id) product = p;
  if (!product) return problem(422, 'invalid_product', 'Invalid product id');
  const qty = (body.payload as { qty?: number } | undefined)?.qty ?? 1;
  if (qty > STOCK) return problem(422, 'out_of_stock', `Only ${STOCK} in stock`);
  held.count += qty;
  held.cents += product.cents * qty;
  return reply(200, { state: { count: held.count, total: held.cents / 100, lastAddedId: product.id } });
}

// The transport only calls `post`.
const server = { post: (_url: string, body: unknown) => answer(body as Envelope) } as unknown as HttpClient;

export const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', httpClient: server }) });
// Share it: useCommand, useSharedCommandState and the directives pick it up.
setCommandBus(bus);

const useCart = defineChamberStore('cart', {
  state: (): Cart => ({ count: 0, total: 0, lastAddedId: null }),
  reducers: { add: null },
  answer: (_state, value) => value as Cart,
});
export const cart = useCart(bus);