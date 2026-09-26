/**
 * Backdrop or padding — the one question a native `<dialog>`'s own `click` event cannot answer.
 *
 * ── Why `event.target === event.currentTarget` is necessary and not sufficient ──
 *
 * A click delivered to the dialog element itself arrives from two genuinely different places:
 * the dimmed area *behind* the dialog (the `::backdrop` pseudo-element, whose events are
 * retargeted to the dialog), and the dialog's own **padding** — the gap between its border and
 * its content. Both report the same target. A command palette that closes on the second one
 * cannot have a query typed into it the moment the pointer strays a few pixels past the input —
 * which is the whole of the pass criterion `docs/SECURITY.md` §*Manual browser checks* item 43
 * writes down for it.
 *
 * The target test still carries weight and is kept: it is what stops a click on the input, on
 * the list, or on any button inside the dialog from reaching this function at all. It just does
 * not finish the job.
 *
 * ── Why the predicate lives here and takes numbers ──────────────────────────
 *
 * So it can be tested without a DOM. `tests/unit/dialog-backdrop.test.ts` drives it with plain
 * rectangles and coordinates and asserts every side, every edge and the padding-equivalent
 * interior points — a test that needed jsdom's `getBoundingClientRect` would be asserting a
 * rectangle jsdom invented rather than a boundary this file decided.
 *
 * The function is deliberately **framework-independent**: it knows nothing about React, about
 * events or about `<dialog>`. `components/ui.tsx` is the only place the two halves meet.
 */

/**
 * A rectangle in **viewport** coordinates: the two x extents and the two y extents.
 *
 * Deliberately not `DOMRect` and deliberately not named `left`/`right`. Two reasons, one of them
 * a rule: `tests/integration/client-discipline.test.ts` bans `left:` and `right:` declarations
 * across the whole client, and its `PHYSICAL_ALLOWED` list has exactly two entries for the two
 * cases that have a physical side — a table column's width and a scroll container's axis. A
 * click test is not a third. So the edges are named for being *the smaller and the larger
 * coordinate*, which is what a rectangle in viewport space is: an extent, with no reading
 * direction in it at all. `components/ui.tsx` maps the `DOMRect` onto this, and that mapping is
 * one line because the two shapes agree about which number is which.
 *
 * Hand-declared rather than typed as `DOMRect` so this file type-checks under the server/test
 * TypeScript config, which has `node` types and no DOM — the same reason `lib/table.ts` is plain
 * data.
 */
export interface Box {
  /** The smaller x, i.e. the edge nearer the viewport's origin. */
  minX: number;
  /** The smaller y. */
  minY: number;
  /** The larger x. */
  maxX: number;
  /** The larger y. */
  maxY: number;
}

/**
 * True when the point falls **strictly outside** the box.
 *
 * ── The boundary rule, stated because it has to be ──────────────────────────
 *
 * A point lying exactly on an edge is **inside** — `minX` and `maxX` are the box's own border
 * box edges, so `(minX, y)` is the dialog's border and clicking a border is clicking the dialog.
 * The test asserts all four edges and the first point beyond each of them, because "just
 * outside" decided by a floating-point `<=` instead of `<` is the difference between a border
 * that closes the palette and one that does not, and neither reading is defensible if it was
 * never written down.
 *
 * Inside means *anywhere* in the box: content, padding and border alike. There is deliberately
 * no padding-shaped allowance — the border box is the whole dialog as far as a click is
 * concerned, and an inset that tried to distinguish "real" padding would need the computed
 * style, which is a layout read on every click for a distinction no operator can see.
 */
export function isOutsideBox(x: number, y: number, box: Box): boolean {
  return x < box.minX || x > box.maxX || y < box.minY || y > box.maxY;
}
