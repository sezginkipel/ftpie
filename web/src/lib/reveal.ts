/**
 * Reveal an element once it scrolls into view.
 *
 * The element must also carry a bare `data-reveal` attribute in the markup. That
 * is what the stylesheet hides, and it is scoped to `html.js`, so with
 * JavaScript unavailable nothing is ever hidden — the content just renders.
 * Setting the attribute from here instead would hide already-painted prerendered
 * markup and cause a visible flash.
 *
 * It unobserves after the first reveal: this is an entrance, not an effect that
 * should replay every time you scroll back up.
 */
export function reveal(node: HTMLElement, delay = 0) {
  if (delay) node.style.setProperty('--reveal-delay', `${delay}ms`);

  const show = () => node.setAttribute('data-reveal', 'in');

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced || typeof IntersectionObserver === 'undefined') {
    show();
    return {};
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          show();
          observer.disconnect();
        }
      }
    },
    // Start a little before the element reaches the viewport edge so the motion
    // has settled by the time it is properly in view.
    { rootMargin: '0px 0px -10% 0px', threshold: 0.05 }
  );

  observer.observe(node);
  return { destroy: () => observer.disconnect() };
}
