import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Cloudflare Workers with static assets. The adapter emits `_worker.js`
    // plus the prerendered/static files into `.svelte-kit/cloudflare`, which is
    // exactly what `wrangler.jsonc` points `main` and `assets.directory` at.
    adapter: adapter({
      platformProxy: {
        // `vite dev` gets real local bindings (KV etc.) through Miniflare, so
        // the dev server behaves like the deployed Worker.
        configPath: 'wrangler.jsonc'
      }
    })
  }
};

export default config;
