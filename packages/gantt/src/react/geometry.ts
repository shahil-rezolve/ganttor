/**
 * Bar and arrow geometry.
 *
 * Kept out of the components so the shapes CRITERIA cares about — bar width, progress
 * fill, milestone marker, arrow routing per dependency type — can be asserted as plain
 * numbers rather than scraped out of rendered DOM.
 */

import type { DayNum } from '../core/day.js';
import type { TimeScale } from '../core/timescale.js';
import type { DepType, ScheduledTask } from '../core/types.js';

export interface RowMetrics {
  /** Height of a task row, including its separator. */
  rowHeight: number;
  /** Height of a task bar. Centred vertically in the row. */
  barHeight: number;
  /** Half-width of a milestone diamond. */
  milestoneRadius: number;
  /** Height of a baseline ghost bar, drawn under the live bar. */
  baselineHeight: number;
}

/**
 * Kept in sync with the `--gantt-row-h` / `--gantt-bar-h` tokens in `gantt.css`: the grid
 * rows are laid out by CSS and the bars are positioned from these numbers, so the two
 * drifting apart shows up immediately as bars sitting between their rows.
 *
 * Sized for legibility over density. A 26px bar inside a 44px row leaves 9px of clear
 * space above and below, which is what keeps a run of adjacent bars reading as separate
 * objects rather than a single striped block.
 */
export const DEFAULT_METRICS: RowMetrics = {
  rowHeight: 44,
  barHeight: 26,
  milestoneRadius: 11,
  baselineHeight: 6,
};

export interface BarBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Width of the progress overlay: `width × percentComplete / 100`. */
  fillWidth: number;
  centerY: number;
}

/** Geometry of a task bar. `rowIndex` is its position in the visible row list. */
export function barBox(
  scale: TimeScale,
  metrics: RowMetrics,
  task: Pick<ScheduledTask, 'start' | 'end' | 'percentComplete'>,
  rowIndex: number,
): BarBox {
  const width = scale.widthOf(task.start, task.end);
  const height = metrics.barHeight;
  const y = rowIndex * metrics.rowHeight + (metrics.rowHeight - height) / 2;
  return {
    x: scale.xOf(task.start),
    y,
    width,
    height,
    fillWidth: (width * clamp01(task.percentComplete / 100)),
    centerY: y + height / 2,
  };
}

export interface DiamondBox {
  /** Centre of the marker — a milestone is anchored on its date, not on a span. */
  cx: number;
  cy: number;
  r: number;
  /** SVG-style points, usable as a CSS `polygon()` too. */
  points: string;
}

export function diamondBox(
  scale: TimeScale,
  metrics: RowMetrics,
  day: DayNum,
  rowIndex: number,
): DiamondBox {
  const cx = scale.centerOf(day);
  const cy = rowIndex * metrics.rowHeight + metrics.rowHeight / 2;
  const r = metrics.milestoneRadius;
  return {
    cx,
    cy,
    r,
    points: `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`,
  };
}

export interface BaselineBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The ghost bar, tucked below the live bar so both are visible at once. */
export function baselineBox(
  scale: TimeScale,
  metrics: RowMetrics,
  bar: { start: DayNum; end: DayNum },
  rowIndex: number,
): BaselineBox {
  const height = metrics.baselineHeight;
  return {
    x: scale.xOf(bar.start),
    width: scale.widthOf(bar.start, bar.end),
    y: rowIndex * metrics.rowHeight + (metrics.rowHeight + metrics.barHeight) / 2 + 1,
    height,
  };
}

/**
 * Which edge of a bar a dependency attaches to.
 *
 * The convention follows the dependency name: the *first* letter names the
 * predecessor's edge, the *second* the successor's. `SF` therefore leaves the
 * predecessor's **start** and arrives at the successor's **finish** — an arrow that
 * genuinely looks backwards, and should, because that is what the relationship says.
 */
export function edgesOf(type: DepType): { fromStart: boolean; toStart: boolean } {
  switch (type) {
    case 'FS':
      return { fromStart: false, toStart: true };
    case 'SS':
      return { fromStart: true, toStart: true };
    case 'FF':
      return { fromStart: false, toStart: false };
    case 'SF':
      return { fromStart: true, toStart: false };
  }
}

export interface ArrowPath {
  /** SVG polyline points. */
  points: string;
  /** Where the arrowhead sits, and which way it faces. */
  head: { x: number; y: number; angle: number };
}

export interface ArrowInput {
  type: DepType;
  from: BarBox | DiamondBox;
  to: BarBox | DiamondBox;
  /** Horizontal stub length before the connector turns. */
  stub?: number;
}

/**
 * Orthogonal elbow routing.
 *
 * Two cases, and the distinction is what stops arrows from cutting back through the
 * bars they connect:
 *
 * - There is room between the two attachment points → a three-segment Z: out, across
 *   at the midpoint, in.
 * - The successor starts at or before the predecessor's edge (common with leads, `SS`,
 *   and `SF`) → a five-segment detour that leaves the row vertically first, travels in
 *   the gutter between rows, and comes back.
 */
export function arrowPath(input: ArrowInput): ArrowPath {
  const stub = input.stub ?? 11;
  const { fromStart, toStart } = edgesOf(input.type);

  const from = anchorOf(input.from, fromStart);
  const to = anchorOf(input.to, toStart);

  // Direction the arrowhead must point to enter the target edge from outside the bar.
  const headAngle = toStart ? 0 : 180;
  const approach = toStart ? -1 : 1;
  const departure = fromStart ? -1 : 1;

  const exitX = from.x + departure * stub;
  const entryX = to.x + approach * stub;

  const hasRoom = departure > 0 ? entryX >= exitX : entryX <= exitX;

  let points: string;
  if (hasRoom) {
    const midX = (exitX + entryX) / 2;
    points = [
      `${round(from.x)},${round(from.y)}`,
      `${round(midX)},${round(from.y)}`,
      `${round(midX)},${round(to.y)}`,
      `${round(to.x)},${round(to.y)}`,
    ].join(' ');
  } else {
    // Route through the gutter below whichever row is higher.
    const gutterY = (from.y + to.y) / 2;
    points = [
      `${round(from.x)},${round(from.y)}`,
      `${round(exitX)},${round(from.y)}`,
      `${round(exitX)},${round(gutterY)}`,
      `${round(entryX)},${round(gutterY)}`,
      `${round(entryX)},${round(to.y)}`,
      `${round(to.x)},${round(to.y)}`,
    ].join(' ');
  }

  return { points, head: { x: round(to.x), y: round(to.y), angle: headAngle } };
}

function anchorOf(box: BarBox | DiamondBox, atStart: boolean): { x: number; y: number } {
  if ('cx' in box) {
    // A milestone has no length, so both edges are its point — offset just enough
    // that an arrow does not vanish under the diamond.
    return { x: box.cx + (atStart ? -box.r : box.r), y: box.cy };
  }
  return { x: atStart ? box.x : box.x + box.width, y: box.centerY };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Half-pixel rounding keeps 1px SVG strokes crisp instead of blurred across two rows. */
function round(value: number): number {
  return Math.round(value * 2) / 2;
}

/**
 * Where a task's label goes.
 *
 * CRITERIA: *"at default zoom, task labels should not overlap or truncate illegibly
 * for at least 20–30 concurrent tasks."* A bar too narrow to hold its text gets the
 * label placed outside instead of clipped — so density costs horizontal room, never
 * legibility.
 */
export type LabelPlacement = 'inside' | 'after' | 'before';

export interface LabelLayout {
  placement: LabelPlacement;
  x: number;
  /** Available width for the text, or `null` when it is unconstrained. */
  maxWidth: number | null;
}

export function labelLayout(
  bar: BarBox | DiamondBox,
  estimatedTextWidth: number,
  viewport: { scrollLeft: number; width: number },
  gap = 8,
  /**
   * Width of the canvas the label sits on. Supplying it bounds an outside label to the
   * axis; omitting it leaves the label unconstrained.
   *
   * This matters for more than tidiness. An outside label is absolutely positioned and
   * `nowrap`, so one placed near the right edge extends *past* `totalWidth` and enlarges
   * the scroll container's `scrollWidth` — producing horizontal scrollbar travel into
   * empty space that no date corresponds to.
   */
  canvasWidth?: number,
): LabelLayout {
  const isDiamond = 'cx' in bar;
  const left = isDiamond ? bar.cx - bar.r : bar.x;
  const right = isDiamond ? bar.cx + bar.r : bar.x + bar.width;
  const width = right - left;

  // Only put text inside a bar with room for it plus its inset padding.
  if (!isDiamond && width >= estimatedTextWidth + gap * 2) {
    return { placement: 'inside', x: left + gap, maxWidth: width - gap * 2 };
  }

  const viewportRight = viewport.scrollLeft + viewport.width;
  if (right + gap + estimatedTextWidth <= viewportRight) {
    const x = right + gap;
    return { placement: 'after', x, maxWidth: capAt(canvasWidth, x, estimatedTextWidth) };
  }

  // No room on the right edge of the viewport — flip to the left of the bar.
  // Clamped at zero: a negative offset would put the text off the axis entirely.
  const x = Math.max(0, left - gap - estimatedTextWidth);
  return { placement: 'before', x, maxWidth: capAt(canvasWidth, x, estimatedTextWidth) };
}

/**
 * The width cap for an outside label, or `null` for none.
 *
 * Only ever caps a label that would otherwise run off the end of the axis. A cap that is
 * wider than the text constrains nothing, and emitting one anyway would put a pointless
 * `max-width` on almost every label — so a label that fits stays genuinely unconstrained
 * and cannot be truncated.
 */
function capAt(
  canvasWidth: number | undefined,
  x: number,
  estimatedTextWidth: number,
): number | null {
  if (canvasWidth === undefined) return null;
  const room = Math.max(0, canvasWidth - x);
  return room >= estimatedTextWidth ? null : room;
}

/** Rough text width for label placement. Cheap, and only ever used for layout choice. */
export function estimateTextWidth(text: string, fontSizePx = 12): number {
  return text.length * fontSizePx * 0.55;
}
