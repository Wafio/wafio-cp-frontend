/**
 * Server-side rendering of `.svelte` components under `bun test`.
 *
 * Registers a runtime plugin that compiles `.svelte` files with the Svelte
 * compiler (server output), strips TypeScript from `<script lang="ts">` and
 * loads CSS imports as nothing. `#lib/...` imports resolve through the
 * `imports` field of package.json. Import this module first, then load
 * components with a dynamic `await import()` and render them with
 * `renderComponent()` to assert on the HTML a state produces (error states,
 * empty states) without a DOM.
 */
import { compile, preprocess } from 'svelte/compiler';
import type { Component } from 'svelte';

const REGISTERED = Symbol.for('wafio.tests.svelte-ssr');
const registry = globalThis as unknown as Record<symbol, boolean>;

if (!registry[REGISTERED]) {
  registry[REGISTERED] = true;
  Bun.plugin({
    name: 'svelte-ssr-components',
    setup(build) {
      build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const pre = await preprocess(
          source,
          {
            script: ({ content, attributes }) =>
              attributes.lang === 'ts' ? { code: new Bun.Transpiler({ loader: 'ts', trimUnusedImports: false }).transformSync(content) } : undefined,
          },
          { filename: path },
        );
        const out = compile(pre.code, { filename: path, generate: 'server', dev: false });
        return { contents: out.js.code, loader: 'js' };
      });
      build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
    },
  });
}

export async function renderComponent<P extends Record<string, unknown>>(component: Component<P>, props: P): Promise<string> {
  const { render } = await import('svelte/server');
  return render(component, { props }).body;
}
