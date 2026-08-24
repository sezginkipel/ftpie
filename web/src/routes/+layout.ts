/**
 * The site is entirely static content, so it is prerendered at build time and
 * served straight from the edge. Nothing here needs a request-time render.
 */
export const prerender = true;
export const trailingSlash = 'never';
