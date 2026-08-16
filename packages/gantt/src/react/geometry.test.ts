/**
 * Bar, marker, and arrow geometry.
 *
 * These are the numbers the renderer turns into pixels, so asserting them here covers
 * CRITERIA's progress-fill and milestone-marker rows without going through the DOM.
 */

import { describe, expect, it } from 'vitest';

import { compileCalendar, DEFAULT_CALENDAR } from '../core/calendar.js';
import { toDayNum } from '../core/day.js';
import { createTimeScale } from '../core/timescale.js';
import type { DepType } from '../core/types.js';
import {
  arrowPath,
  barBox,
  baselineBox,
  DEFAULT_METRICS as M,
  diamondBox,
  edgesOf,
  estimateTextWidth,
  labelLayout,
} from './geometry.js';

const calendar = compileCalendar(DEFAULT_CALENDAR);
const from = toDayNum('2026-03-02');
const scale = createTimeScale({ unit: 'day', from, to: from + 60, calendar, padDays: 0 });

describe('bar geometry', () => {
  it('is as wide as the span is long', () => {
    const bar = barBox(scale, M, { start: from, end: from + 4, percentComplete: 0 }, 0);
    expect(bar.x).toBe(0);
    expect(bar.width).toBeCloseTo(scale.pxPerDay * 5, 10);
  });

  it('centres the bar in its row', () => {
    const bar = barBox(scale, M, { start: from, end: from, percentComplete: 0 }, 3);
    expect(bar.y).toBe(3 * M.rowHeight + (M.rowHeight - M.barHeight) / 2);
    expect(bar.centerY).toBe(bar.y + M.barHeight / 2);
  });

  it('stacks rows at exactly the row height', () => {
    const first = barBox(scale, M, { start: from, end: from, percentComplete: 0 }, 0);
    const second = barBox(scale, M, { start: from, end: from, percentComplete: 0 }, 1);
    expect(second.y - first.y).toBe(M.rowHeight);
  });
});

describe('progress fill accuracy', () => {
  // CRITERIA: "Set task to 60% complete; bar fill visually reflects 60% of its length."
  const cases = [0, 25, 60, 99, 100];

  for (const pct of cases) {
    it(`fills ${pct}% of the bar at ${pct}% complete`, () => {
      const bar = barBox(scale, M, { start: from, end: from + 9, percentComplete: pct }, 0);
      expect(bar.fillWidth).toBeCloseTo(bar.width * (pct / 100), 10);
    });
  }

  it('clamps nonsense values instead of overflowing the bar', () => {
    const over = barBox(scale, M, { start: from, end: from + 4, percentComplete: 140 }, 0);
    expect(over.fillWidth).toBe(over.width);
    const under = barBox(scale, M, { start: from, end: from + 4, percentComplete: -20 }, 0);
    expect(under.fillWidth).toBe(0);
  });
});

describe('milestone markers', () => {
  it('is a point on its date, not a span', () => {
    const diamond = diamondBox(scale, M, from + 3, 2);
    expect(diamond.cx).toBeCloseTo(scale.centerOf(from + 3), 10);
    expect(diamond.cy).toBe(2 * M.rowHeight + M.rowHeight / 2);
    expect(diamond.r).toBe(M.milestoneRadius);
  });

  it('describes a four-point diamond, not a rectangle', () => {
    const diamond = diamondBox(scale, M, from, 0);
    expect(diamond.points.split(' ')).toHaveLength(4);
  });
});

describe('baseline ghost bars', () => {
  it('sits below the live bar so both are visible', () => {
    const bar = barBox(scale, M, { start: from, end: from + 4, percentComplete: 0 }, 0);
    const ghost = baselineBox(scale, M, { start: from, end: from + 4 }, 0);
    expect(ghost.x).toBe(bar.x);
    expect(ghost.width).toBe(bar.width);
    expect(ghost.y).toBeGreaterThan(bar.y + bar.height - 1);
    expect(ghost.height).toBe(M.baselineHeight);
  });
});

describe('arrow attachment edges', () => {
  // The first letter of the type names the predecessor's edge, the second the successor's.
  const expected: Record<DepType, { fromStart: boolean; toStart: boolean }> = {
    FS: { fromStart: false, toStart: true },
    SS: { fromStart: true, toStart: true },
    FF: { fromStart: false, toStart: false },
    SF: { fromStart: true, toStart: false },
  };

  for (const [type, want] of Object.entries(expected) as [DepType, typeof expected.FS][]) {
    it(`${type} leaves the predecessor's ${want.fromStart ? 'start' : 'finish'} and enters the successor's ${want.toStart ? 'start' : 'finish'}`, () => {
      expect(edgesOf(type)).toEqual(want);
    });
  }
});

describe('arrow routing', () => {
  const a = barBox(scale, M, { start: from, end: from + 4, percentComplete: 0 }, 0);
  const b = barBox(scale, M, { start: from + 8, end: from + 12, percentComplete: 0 }, 1);

  it('starts on the predecessor edge and ends on the successor edge', () => {
    const path = arrowPath({ type: 'FS', from: a, to: b });
    const points = path.points.split(' ').map((p) => p.split(',').map(Number) as [number, number]);
    expect(points[0]![0]).toBeCloseTo(a.x + a.width, 0);
    expect(points[0]![1]).toBeCloseTo(a.centerY, 0);
    expect(points[points.length - 1]![0]).toBeCloseTo(b.x, 0);
    expect(points[points.length - 1]![1]).toBeCloseTo(b.centerY, 0);
  });

  it('routes with right angles only', () => {
    const path = arrowPath({ type: 'FS', from: a, to: b });
    const points = path.points.split(' ').map((p) => p.split(',').map(Number) as [number, number]);
    for (let i = 1; i < points.length; i++) {
      const dx = Math.abs(points[i]![0] - points[i - 1]![0]);
      const dy = Math.abs(points[i]![1] - points[i - 1]![1]);
      // Each segment moves in exactly one axis.
      expect(dx === 0 || dy === 0).toBe(true);
    }
  });

  it('takes the short three-segment route when there is room', () => {
    const path = arrowPath({ type: 'FS', from: a, to: b });
    expect(path.points.split(' ')).toHaveLength(4);
  });

  it('detours through the gutter when the successor starts before the predecessor ends', () => {
    const overlapping = barBox(scale, M, { start: from + 1, end: from + 5, percentComplete: 0 }, 1);
    const path = arrowPath({ type: 'FS', from: a, to: overlapping });
    // A straight Z would cut back through both bars, so the router adds two segments.
    expect(path.points.split(' ')).toHaveLength(6);
  });

  it('points the arrowhead into the edge it arrives at', () => {
    expect(arrowPath({ type: 'FS', from: a, to: b }).head.angle).toBe(0);
    expect(arrowPath({ type: 'SS', from: a, to: b }).head.angle).toBe(0);
    // FF and SF arrive at a finish edge, so the head faces the other way.
    expect(arrowPath({ type: 'FF', from: a, to: b }).head.angle).toBe(180);
    expect(arrowPath({ type: 'SF', from: a, to: b }).head.angle).toBe(180);
  });

  it('attaches to a milestone at its point rather than at a bar edge', () => {
    const diamond = diamondBox(scale, M, from + 8, 1);
    const path = arrowPath({ type: 'FS', from: a, to: diamond });
    const last = path.points.split(' ').pop()!.split(',').map(Number);
    expect(last[0]).toBeCloseTo(diamond.cx - diamond.r, 0);
    expect(last[1]).toBeCloseTo(diamond.cy, 0);
  });

  it('rounds to half pixels so a 1px stroke stays crisp', () => {
    const path = arrowPath({ type: 'FS', from: a, to: b });
    for (const value of path.points.split(/[ ,]/).map(Number)) {
      expect((value * 2) % 1).toBe(0);
    }
  });
});

describe('label placement', () => {
  const viewport = { scrollLeft: 0, width: 1000 };

  it('puts the label inside a bar with room for it', () => {
    const wide = barBox(scale, M, { start: from, end: from + 20, percentComplete: 0 }, 0);
    const layout = labelLayout(wide, estimateTextWidth('Short name'), viewport);
    expect(layout.placement).toBe('inside');
    expect(layout.maxWidth).toBeLessThan(wide.width);
  });

  it('places the label after a bar too narrow to hold it, rather than clipping', () => {
    const narrow = barBox(scale, M, { start: from, end: from, percentComplete: 0 }, 0);
    const layout = labelLayout(narrow, estimateTextWidth('A rather long task name'), viewport);
    expect(layout.placement).toBe('after');
    expect(layout.x).toBeGreaterThan(narrow.x + narrow.width);
    // Outside labels are never width-limited, so they cannot be truncated.
    expect(layout.maxWidth).toBeNull();
  });

  it('flips to the left when there is no room at the right viewport edge', () => {
    const atEdge = barBox(scale, M, { start: from + 28, end: from + 28, percentComplete: 0 }, 0);
    const layout = labelLayout(atEdge, estimateTextWidth('Trailing label'), {
      scrollLeft: 0,
      width: atEdge.x + 10,
    });
    expect(layout.placement).toBe('before');
    expect(layout.x).toBeLessThan(atEdge.x);
  });

  it('never puts a label inside a milestone marker', () => {
    const diamond = diamondBox(scale, M, from, 0);
    expect(labelLayout(diamond, 10, viewport).placement).not.toBe('inside');
  });
});
