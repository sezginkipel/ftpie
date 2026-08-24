# ftpie.dev — product site

Marketing/landing site for ftpie. SvelteKit rendered on **Cloudflare Workers**,
with static assets served from the same deployment.

Live: <https://ftpie-web.1444sezgin.workers.dev>

## Stack

| Piece | What it does |
| --- | --- |
| SvelteKit 2 + Svelte 5 | The app, using runes (`$props`, `$state`) |
| `@sveltejs/adapter-cloudflare` | Emits `_worker.js` + assets into `.svelte-kit/cloudflare` |
| Cloudflare Workers | Server-side rendering at the edge |
| Workers Static Assets | Serves the built client bundle and `static/` |
| Workers KV (`STATS`) | Approximate page-view counter |
| `request.cf` | Shows the real colo/country the response came from |

## Commands

```bash
npm install

npm run dev      # vite dev on :5174, with local Miniflare bindings
npm run check    # regenerates Worker types, then svelte-check (must be 0 errors)
npm run build    # production build through the Cloudflare adapter
npm run preview  # run the built Worker locally via wrangler
npm run deploy   # build + wrangler deploy
```

`npm run check` runs `cf-typegen` first, so `src/worker-configuration.d.ts` is
always regenerated from `wrangler.jsonc`. That file is gitignored on purpose —
it is ~580 KB of generated runtime types that would churn on every Workers
release. **Rerun `npm run cf-typegen` after changing a binding**, or the types
and the deployed configuration will drift.

## Content accuracy

Every factual claim lives in [`src/lib/data.ts`](src/lib/data.ts) so it can be
checked in one place. The rule is simple: **if the shipped app does not do it, it
does not go on the site.**

This is not incidental. ftpie's original design document promised WebDAV, S3,
real-time collaboration, a plugin system and encrypted cloud sync — none of
which existed, and two of which (WebDAV/S3) silently fell through to a plaintext
FTP handshake that leaked credentials. That document now carries a correction
table, and the site has a "what ftpie deliberately does not do" section rather
than quietly omitting the gaps.

Two consequences worth knowing before editing:

- `PUBLISHED_BINARIES` is `false` and there are no download links. Release
  signing is not configured, and offering unsigned installers would be the exact
  trust problem the product exists to avoid. Flip it only when signed artifacts
  actually exist.
- `REPO` is an empty string, not a plausible-looking URL. The source links only
  render once it is filled in.

## Notes

- The hero product shot is a CSS reconstruction of the real window
  ([`AppMock.svelte`](src/lib/AppMock.svelte)) rather than a screenshot, so it
  cannot go stale and needs no image asset.
- The KV counter is labelled "approximate" because KV has no atomic increment;
  concurrent views can collapse into one. Durable Objects would be the fix if it
  ever needed to be exact.
- `app.css` scopes its section spacing to `main > section`. A bare `section`
  selector also matched the `<section>` elements inside the product mock and
  padded them by 88px, which pushed their headers and footers into the middle of
  the pane.
