/**
 * Shared accessibility class recipes.
 *
 * These live in TypeScript rather than in a CSS `@layer` so the conformance
 * tests can read them: Vitest stubs CSS imports to an empty string, so a rule
 * defined in `index.css` cannot be asserted, and an unassertable rule is
 * exactly what `P1-UI-002` exists to stop relying on.
 */

/**
 * Expand a small control's activation area to 24x24 (WCAG 2.2 SC 2.5.8).
 *
 * Apply to the element *wrapping* the input — browsers do not render
 * pseudo-elements on replaced elements like `<input>`, and a `<label>` wrapper
 * is what makes the expanded area actually toggle the control.
 *
 * Nothing moves: the hit area is centred on the control and drawn outside the
 * layout. Use it where the control is deliberately small — a 14px checkbox over
 * a thumbnail, where a larger box would cover the image it describes. Where a
 * control already has visible text, give its label `min-h-6` instead: the label
 * is the target, and it only needs height.
 */
export const MIN_TARGET_24 =
  "relative inline-flex before:absolute before:left-1/2 before:top-1/2 " +
  "before:h-6 before:w-6 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";
