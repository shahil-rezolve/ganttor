/**
 * The axis window.
 *
 * Driven as a pure function rather than through the DOM on purpose: in jsdom
 * `scrollLeft` and `scrollWidth` are always `0`, `clientWidth` is stubbed to a constant,
 * and `ResizeObserver` never fires its callback. Rendering a chart and scrolling it would
 * assert the behaviour of those stubs. These assertions are about the arithmetic that
 * decides when to grow and by how much, which is the part that can actually be wrong.
 */

import { describe, expect, it } from 'vitest';

import { growAxis, initialPad, type AxisPad, type ScrollGeometry } from './axisWindow.js';

const PAD: AxisPad = { before: 30, after: 30 };

/** A viewport parked in the middle of a comfortably larger canvas. */
function middle(overrides: Partial<ScrollGeometry> = {}): ScrollGeometry {
  return { scrollLeft: 5000, clientWidth: 1000, scrollWidth: 12000, pxPerDay: 34, ...overrides };
}

describe('initial padding', () => {
  it('scales with the zoom, because padding is really about screen room', () => {
    // A day is 34px at day zoom and 1.6px at quarter zoom, so a flat day count would
    // give 30 days ≈ 1020px at one end and ≈ 48px at the other.
    const day = initialPad('day').before;
    const quarter = initialPad('quarter').before;
    expect(quarter).toBeGreaterThan(day);
  });

  it('pads both sides equally to start with', () => {
    for (const unit of ['day', 'week', 'month', 'quarter'] as const) {
      const pad = initialPad(unit);
      expect(pad.before).toBe(pad.after);
      expect(pad.before).toBeGreaterThan(0);
    }
  });
});

describe('growing the axis', () => {
  it('leaves the pad untouched away from either edge', () => {
    const result = growAxis(middle(), PAD);
    // Identity, not just equality: the caller skips the state update on this.
    expect(result.pad).toBe(PAD);
    expect(result.scrollCorrection).toBe(0);
  });

  it('extends the leading edge when the view approaches it', () => {
    const result = growAxis(middle({ scrollLeft: 200 }), PAD);
    expect(result.pad.before).toBeGreaterThan(PAD.before);
  });

  it('does not extend the trailing edge while only the leading edge is near', () => {
    const result = growAxis(middle({ scrollLeft: 200 }), PAD);
    expect(result.pad.after).toBe(PAD.after);
  });

  it('extends the trailing edge when the view approaches it', () => {
    // scrollWidth − (scrollLeft + clientWidth) = 500, inside one viewport of the end.
    const result = growAxis(middle({ scrollLeft: 10500 }), PAD);
    expect(result.pad.after).toBeGreaterThan(PAD.after);
    expect(result.pad.before).toBe(PAD.before);
  });

  it('extends both ends at once on a canvas narrower than two viewports', () => {
    const result = growAxis(
      { scrollLeft: 0, clientWidth: 1000, scrollWidth: 1200, pxPerDay: 34 },
      PAD,
    );
    expect(result.pad.before).toBeGreaterThan(PAD.before);
    expect(result.pad.after).toBeGreaterThan(PAD.after);
  });

  /*
   * The invariant that matters: growing leftwards moves every existing x-coordinate
   * right by exactly `addedDays × pxPerDay`. Correcting `scrollLeft` by the same amount
   * is what keeps the date under the cursor where it was — without it the view jumps.
   */
  it('reports a correction equal to the pixels the content shifted', () => {
    const geometry = middle({ scrollLeft: 200 });
    const result = growAxis(geometry, PAD);
    const addedDays = result.pad.before - PAD.before;
    expect(result.scrollCorrection).toBeCloseTo(addedDays * geometry.pxPerDay, 6);
  });

  it('preserves the visible date when the correction is applied', () => {
    const geometry = middle({ scrollLeft: 200 });
    // Whatever day sat at the left edge before growing…
    const dayAtEdgeBefore = geometry.scrollLeft / geometry.pxPerDay;

    const result = growAxis(geometry, PAD);
    const addedDays = result.pad.before - PAD.before;
    const correctedScrollLeft = geometry.scrollLeft + result.scrollCorrection;

    // …still sits there afterwards, once the new origin is accounted for.
    const dayAtEdgeAfter = correctedScrollLeft / geometry.pxPerDay - addedDays;
    expect(dayAtEdgeAfter).toBeCloseTo(dayAtEdgeBefore, 6);
  });

  it('never corrects for growth that only appended to the right', () => {
    const result = growAxis(middle({ scrollLeft: 10500 }), PAD);
    expect(result.scrollCorrection).toBe(0);
  });

  it('adds about one viewport of days per extension', () => {
    const geometry = middle({ scrollLeft: 0 });
    const result = growAxis(geometry, PAD);
    const addedPx = (result.pad.before - PAD.before) * geometry.pxPerDay;
    expect(addedPx).toBeGreaterThan(geometry.clientWidth * 0.5);
    expect(addedPx).toBeLessThan(geometry.clientWidth * 2);
  });

  it('caps growth at one chunk per call, so a fling cannot run away', () => {
    // Repeatedly asking while pinned at the edge must grow linearly, not compound.
    let pad = PAD;
    for (let i = 0; i < 5; i++) pad = growAxis(middle({ scrollLeft: 0 }), pad).pad;
    const chunk = Math.round(1000 / 34);
    expect(pad.before).toBe(PAD.before + chunk * 5);
  });

  it('refuses to grow on unmeasured geometry rather than guessing', () => {
    // jsdom, a hidden container, or the first paint before layout has happened.
    for (const geometry of [
      middle({ clientWidth: 0 }),
      middle({ scrollWidth: 0 }),
      middle({ pxPerDay: 0 }),
    ]) {
      expect(growAxis(geometry, PAD).pad).toBe(PAD);
    }
  });
});
