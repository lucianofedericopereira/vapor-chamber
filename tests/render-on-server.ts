/**
 * Render a template to a string the way a server bundle would.
 *
 * The server half imports `vue` (node entry) and `@vue/server-renderer`, the graph the renderer resolves; the client half of a fixture uses the with-vapor browser dist. Only the string crosses, because two separately imported Vue dists have disconnected instances.
 * The generated SSR module's imports are parsed, not listed: the helpers needed depend on the template.
 * `vapor` is the compiler's own switch, as a Vapor SFC's server build sets it: a `v-if` chain marks its branch only under it.
 */

import { createDirectivePlugin } from '../src/directives';

export async function renderOnTheServer(source: string, ctx: Record<string, unknown>, vapor = false): Promise<string> {
  const vnode: Record<string, unknown> = await import('vue');
  const sr: Record<string, unknown> = await import('@vue/server-renderer');
  const { compileTemplate } = await import('vue/compiler-sfc');

  const { code, errors } = compileTemplate({ source, filename: 'T.vue', id: 'h', ssr: true, vapor });
  if (errors.length > 0) throw new Error(`renderOnTheServer(): ${source}\n${errors.map(String).join('\n')}`);

  let body = code.replace('export function ssrRender', 'return function ssrRender');
  const names: string[] = [];
  const values: unknown[] = [];
  for (const m of code.matchAll(/^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)"$/gm)) {
    const mod = m[2] === 'vue' ? vnode : m[2] === 'vue/server-renderer' ? sr : null;
    if (!mod) throw new Error(`ssr code imports from an unexpected module: ${m[2]}`);
    for (const part of m[1].split(',')) {
      const [orig, local] = part.trim().split(/\s+as\s+/);
      if (!orig) continue;
      if (!(orig in mod)) throw new Error(`${m[2]} has no "${orig}"`);
      names.push(local ?? orig);
      values.push(mod[orig]);
    }
    body = body.replace(`${m[0]}\n`, '');
  }
  const ssrRender = new Function(...names, body)(...values);

  const app = (vnode.createSSRApp as (o: unknown) => { use: (p: unknown) => void })({
    ssrRender,
    data: () => ({ ...ctx }),
  });
  app.use(createDirectivePlugin());
  return (sr.renderToString as (a: unknown) => Promise<string>)(app);
}
