import { describe, it, expect } from 'vitest';
import { isOutsideBox, type Box } from '../../src/client/lib/backdrop.js';

/**
 * The backdrop test: coordinates against a rectangle, with no DOM anywhere.
 *
 * The defect this exists for is narrow and easy to re-introduce. A native `<dialog>` delivers a
 * click on its own **padding** and a click on the dimmed area behind it to the same handler with
 * the same target — `event.target === event.currentTarget` for both — so a predicate that stops
 * at the target test closes the command palette when the pointer strays a few pixels past the
 * input, and the palette cannot then have a query typed into it.
 *
 * What this file sees: the pure decision, over hand-written rectangles, on every side, on every
 * edge and at the points a padding area actually occupies. What it does not see: that
 * `components/ui.tsx` calls it — that is a source assertion in
 * `tests/integration/m22-ui.test.ts`, because a test that cannot render a component also cannot
 * observe its event wiring by executing it.
 */

/** A dialog-sized box at a non-origin position, so a coordinate mix-up cannot pass unnoticed. */
const DIALOG: Box = { minX: 100, minY: 50, maxX: 300, maxY: 250 };

describe('M2.2 — backdrop clicks are told apart from dialog padding', () => {
  it('is outside on each of the four sides', () => {
    // Mid-edge, so only one axis can be responsible for each result.
    expect(isOutsideBox(99, 150, DIALOG), 'left of the box').toBe(true);
    expect(isOutsideBox(301, 150, DIALOG), 'right of the box').toBe(true);
    expect(isOutsideBox(200, 49, DIALOG), 'above the box').toBe(true);
    expect(isOutsideBox(200, 251, DIALOG), 'below the box').toBe(true);
    // Outside on both axes at once, which is the common case: the corners of the backdrop.
    expect(isOutsideBox(0, 0, DIALOG), 'top-left of the backdrop').toBe(true);
    expect(isOutsideBox(999, 999, DIALOG), 'bottom-right of the backdrop').toBe(true);
  });

  it('is inside everywhere in the content, including where the padding is', () => {
    expect(isOutsideBox(200, 150, DIALOG), 'the centre').toBe(false);
    // A padding area is *inside* the border box: a few pixels in from each corner, which is
    // where the reported defect happened — the gap between the input and the dialog's border.
    expect(isOutsideBox(104, 54, DIALOG), 'padding at the top-left').toBe(false);
    expect(isOutsideBox(296, 54, DIALOG), 'padding at the top-right').toBe(false);
    expect(isOutsideBox(104, 246, DIALOG), 'padding at the bottom-left').toBe(false);
    expect(isOutsideBox(296, 246, DIALOG), 'padding at the bottom-right').toBe(false);
    // The first point inside each edge, so the interior half of the boundary is covered too.
    expect(isOutsideBox(100.001, 150, DIALOG), 'just inside the left edge').toBe(false);
    expect(isOutsideBox(299.999, 150, DIALOG), 'just inside the right edge').toBe(false);
    expect(isOutsideBox(200, 50.001, DIALOG), 'just inside the top edge').toBe(false);
    expect(isOutsideBox(200, 249.999, DIALOG), 'just inside the bottom edge').toBe(false);
  });

  it('treats an exact edge or corner as inside, and states the rule by asserting both halves', () => {
    // Clicking a border is clicking the dialog. Written down because `<=` instead of `<` is the
    // difference between a border that dismisses the palette and one that does not, and neither
    // reading is defensible if it was never chosen.
    expect(isOutsideBox(100, 150, DIALOG), 'the left edge').toBe(false);
    expect(isOutsideBox(300, 150, DIALOG), 'the right edge').toBe(false);
    expect(isOutsideBox(200, 50, DIALOG), 'the top edge').toBe(false);
    expect(isOutsideBox(200, 250, DIALOG), 'the bottom edge').toBe(false);
    expect(isOutsideBox(100, 50, DIALOG), 'the top-left corner').toBe(false);
    expect(isOutsideBox(300, 250, DIALOG), 'the bottom-right corner').toBe(false);

    // And the first point beyond each of them, so the exterior half is covered by the same
    // sweep rather than by an assumption about floating point.
    expect(isOutsideBox(99.999, 150, DIALOG)).toBe(true);
    expect(isOutsideBox(300.001, 150, DIALOG)).toBe(true);
    expect(isOutsideBox(200, 49.999, DIALOG)).toBe(true);
    expect(isOutsideBox(200, 250.001, DIALOG)).toBe(true);
  });

  it('separates the two clicks that share a target, which target equality cannot', () => {
    // Both of these are delivered to the dialog element itself — the target test is satisfied
    // by each — so a predicate that stopped at `event.target === event.currentTarget` would
    // return the same answer for both. This is the assertion that makes the coordinate half
    // non-vacuous: the two disagree, and only one of them may close.
    const padding = { x: 104, y: 54 };
    const backdrop = { x: 40, y: 150 };
    const targetIsTheDialog = true;

    const closes = (point: { x: number; y: number }): boolean =>
      targetIsTheDialog && isOutsideBox(point.x, point.y, DIALOG);

    expect(closes(padding), 'a click on the dialog padding').toBe(false);
    expect(closes(backdrop), 'a click on the backdrop').toBe(true);
    // And the target test is still load-bearing: an interior click on a child element is not
    // even asked, so a coordinate test that wrongly returned true could not close it either.
    const targetIsAChild = false;
    expect(targetIsAChild && isOutsideBox(200, 150, DIALOG)).toBe(false);
  });

  it('takes a rectangle of any position, including one at the origin', () => {
    const origin: Box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(isOutsideBox(-1, 5, origin)).toBe(true);
    expect(isOutsideBox(5, -1, origin)).toBe(true);
    expect(isOutsideBox(5, 5, origin)).toBe(false);
    expect(isOutsideBox(10, 10, origin)).toBe(false);
    expect(isOutsideBox(10.001, 10.001, origin)).toBe(true);
  });
});
