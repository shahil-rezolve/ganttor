/**
 * How far the axis extends, and when to extend it further.
 *
 * The axis used to span exactly the project's own dates ±7 days, so there was simply no
 * canvas to scroll into: you could not look at the month before a project started, and
 * "scrolling freely in both directions" was impossible by construction rather than by
 * bug. Now the padding grows on demand as you approach either edge.
 *
 * ── Why this is a pure function ──────────────────────────────────────────────────────
 *
 * All of it is expressed as `(scroll geometry, current pad) → next pad`, deliberately
 * kept out of the scroll handler. In jsdom `scrollLeft` and `scrollWidth` are always `0`,
 * `clientWidth` is stubbed to a constant, and `ResizeObserver` never fires — so driving
 * this through the DOM in a test would assert the behaviour of the stubs, not of the
 * logic. As a function of numbers it is directly testable.
 */

import type { ScaleUnit } from '../core/timescale.js';

export interface AxisPad {
  /** Calendar days of axis before the project's own start. */
  before: number;
  /** Calendar days of axis after the project's own finish. */
  after: number;
}

/**
 * Opening padding per zoom level, in calendar days.
 *
 * Scaled by unit rather than flat, because padding is really about *screen* room: at
 * quarter zoom a day is 1.6px, so 30 days of pad is 48px — invisible. These give roughly
 * a screenful of slack at every zoom.
 */
const INITIAL_PAD_DAYS: Record<ScaleUnit, number> = {
  day: 30,
  week: 90,
  month: 270,
  quarter: 730,
};

/** How much axis one extension adds, as a multiple of the visible width. */
const GROWTH_FACTOR = 1;

/** Extend once the edge is within this fraction of a viewport. */
const TRIGGER_FRACTION = 1;

export function initialPad(unit: ScaleUnit): AxisPad {
  const days = INITIAL_PAD_DAYS[unit];
  return { before: days, after: days };
}

export interface ScrollGeometry {
  /** Scroll offset of the container. */
  scrollLeft: number;
  /** Visible width of the container. */
  clientWidth: number;
  /** Total scrollable width of the container's content. */
  scrollWidth: number;
  /** Pixels per calendar day at the current zoom. */
  pxPerDay: number;
}

export interface AxisGrowth {
  pad: AxisPad;
  /**
   * Pixels the content shifted right because the axis grew leftwards. The scroller must
   * be corrected by this amount in the same layout tick, or the view visibly jumps.
   */
  scrollCorrection: number;
}

/**
 * Decide whether the axis needs more room, given where the viewport is.
 *
 * Returns the *same* pad object when nothing needs to change, so a caller can skip the
 * state update on the overwhelming majority of scroll events.
 *
 * Growth is capped at one chunk per side per call: a single fling would otherwise call
 * this at 60Hz while still near the edge and add a chunk every frame, walking the axis
 * out to years of empty canvas before the gesture ended.
 */
export function growAxis(geometry: ScrollGeometry, pad: AxisPad): AxisGrowth {
  const { scrollLeft, clientWidth, scrollWidth, pxPerDay } = geometry;

  // Degenerate geometry — an unmeasured or hidden container. Never grow on a guess.
  if (!(pxPerDay > 0) || clientWidth <= 0 || scrollWidth <= 0) {
    return { pad, scrollCorrection: 0 };
  }

  const chunkDays = Math.max(1, Math.round((clientWidth * GROWTH_FACTOR) / pxPerDay));
  const trigger = clientWidth * TRIGGER_FRACTION;

  const nearStart = scrollLeft <= trigger;
  const nearEnd = scrollWidth - (scrollLeft + clientWidth) <= trigger;

  if (!nearStart && !nearEnd) return { pad, scrollCorrection: 0 };

  return {
    pad: {
      before: nearStart ? pad.before + chunkDays : pad.before,
      after: nearEnd ? pad.after + chunkDays : pad.after,
    },
    // Only leftward growth moves existing content; rightward growth appends.
    scrollCorrection: nearStart ? chunkDays * pxPerDay : 0,
  };
}
