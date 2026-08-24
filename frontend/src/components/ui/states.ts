/**
 * The one interaction-state vocabulary every primitive composes from.
 *
 * The spec asks for five states on every interactive element (rest, hover,
 * press, focus-visible, disabled) plus a selected treatment. Spelling those out
 * per component is how a library drifts, so they live here as three composable
 * strings and each primitive picks the ones it needs. Nothing in this file is
 * re-exported from the barrel — it is internal chrome, not API.
 */

/**
 * Rest → hover → press → disabled, minus focus. `.press` supplies the 0.5px
 * settle; `.transition-quick` makes the colour change readable without lagging.
 */
export const interactive =
  'transition-quick press disabled:pointer-events-none disabled:cursor-not-allowed ' +
  'disabled:opacity-50 disabled:shadow-none';

/**
 * Focus for a control that may live inside a scroller. The global
 * `:focus-visible` outline is inset, but on a rounded control it still reads as
 * a square notch and gets clipped by `overflow: hidden` ancestors, so form
 * controls swap it for the `shadow-focus` halo, which follows the radius.
 */
export const focusRing =
  'focus-visible:outline-none focus-visible:shadow-focus focus-visible:border-accent';

/**
 * Focus for a control that is not inside a clipping scroller and whose own
 * box-shadow is carrying elevation (buttons). Keeps the global ring but pulls it
 * outside the border so a filled button still shows it.
 */
export const focusOutline =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]';

/**
 * The selected row/item treatment: tinted background, full-strength text, and a
 * 2px inset accent edge so selection survives a monochrome screenshot.
 */
export const selectedEdge = 'shadow-[inset_2px_0_0_0_var(--accent)]';
