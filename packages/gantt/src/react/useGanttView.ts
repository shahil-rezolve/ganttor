/**
 * The view model.
 *
 * One hook turns a `Project` into everything the renderer needs: the schedule, the
 * visible row list after collapsing, the time scale, the colour scheme, and the arrow
 * geometry. Components below it are then almost entirely presentational, which is what
 * keeps them small enough to test.
 *
 * `schedule()` is pure, so memoising on the project reference is exact — no dependency
 * array guesswork.
 */

import { useMemo } from 'react';

import { compileCalendar, type CompiledCalendar } from '../core/calendar.js';
import { baselineBarOf } from '../core/baseline.js';
import type { DayNum } from '../core/day.js';
import { activeBaseline } from '../core/project.js';
import { schedule } from '../core/schedule.js';
import { createTimeScale, type ScaleUnit, type TimeScale } from '../core/timescale.js';
import type { Baseline, Project, ScheduleResult, ScheduledTask, Task } from '../core/types.js';
import { buildWbs, type Wbs } from '../core/wbs.js';
import { arrowPath, barBox, baselineBox, diamondBox, DEFAULT_METRICS, type ArrowPath, type BarBox, type BaselineBox, type DiamondBox, type RowMetrics } from './geometry.js';
import { createColorScheme, type ColorScheme } from './palette.js';

export interface GanttRow {
  task: Task;
  scheduled: ScheduledTask;
  rowIndex: number;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  color: string;
  bar: BarBox | null;
  diamond: DiamondBox | null;
  baseline: BaselineBox | null;
}

export interface GanttArrow {
  dependency: { id: string; predecessorId: string; successorId: string; type: string };
  path: ArrowPath;
  isCritical: boolean;
  isCyclic: boolean;
}

export interface GanttView {
  result: ScheduleResult;
  wbs: Wbs;
  calendar: CompiledCalendar;
  scale: TimeScale;
  colors: ColorScheme;
  rows: GanttRow[];
  rowByTaskId: ReadonlyMap<string, GanttRow>;
  arrows: GanttArrow[];
  metrics: RowMetrics;
  baseline: Baseline | null;
  canvasHeight: number;
  /** Resource display names, for avatars and the legend. */
  resourceNames: ReadonlyMap<string, string>;
}

export interface UseGanttViewOptions {
  project: Project;
  unit: ScaleUnit;
  metrics?: RowMetrics;
  /** Calendar days of padding either side of the project span. */
  padDays?: number;
  /**
   * Asymmetric padding, when the two sides differ. Takes precedence over `padDays`.
   *
   * The axis grows independently at each end as you scroll towards it, so a single
   * symmetric number cannot express the window: scrolling left must not silently extend
   * the right-hand side as well.
   */
  padBefore?: number;
  padAfter?: number;
}

export function useGanttView(options: UseGanttViewOptions): GanttView {
  const { project, unit } = options;
  const metrics = options.metrics ?? DEFAULT_METRICS;
  const padDays = options.padDays ?? 7;
  const padBefore = options.padBefore ?? padDays;
  const padAfter = options.padAfter ?? padDays;

  const result = useMemo(() => schedule(project), [project]);
  const wbs = useMemo(() => buildWbs(project.tasks), [project.tasks]);
  const calendar = useMemo(() => compileCalendar(project.calendar), [project.calendar]);
  const baseline = useMemo(() => activeBaseline(project), [project]);

  const resourceNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const resource of project.resources) names.set(resource.id, resource.name);
    return names;
  }, [project.resources]);

  const colors = useMemo(
    () =>
      createColorScheme({
        colorBy: project.settings.colorBy,
        tasks: project.tasks,
        resourceNames,
      }),
    [project.settings.colorBy, project.tasks, resourceNames],
  );

  const scale = useMemo(() => {
    // A baseline can extend past the live schedule, and its ghost bar must stay on-axis.
    let from = result.projectStart;
    let to = result.projectFinish;
    if (baseline) {
      for (const bar of Object.values(baseline.bars)) {
        if (bar.start < from) from = bar.start;
        if (bar.end > to) to = bar.end;
      }
    }
    /*
     * `createTimeScale` still takes a single symmetric `padDays`, so the asymmetry is
     * applied to the span here instead. Keeping its signature untouched is deliberate:
     * `timescale.test.ts` pins that contract, and the padding shape is a renderer
     * concern rather than a scale one.
     */
    return createTimeScale({
      unit,
      from: from - padBefore,
      to: to + padAfter,
      calendar,
      padDays: 0,
    });
  }, [unit, result.projectStart, result.projectFinish, calendar, padBefore, padAfter, baseline]);

  const taskById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of project.tasks) map.set(task.id, task);
    return map;
  }, [project.tasks]);

  const rows = useMemo(() => {
    const visible: GanttRow[] = [];
    const showBaseline = project.settings.showBaseline;

    // Walk the display order, skipping the subtree of any collapsed parent.
    let skipUnderDepth: number | null = null;

    for (const id of result.order) {
      const depth = wbs.depthOf.get(id) ?? 0;

      if (skipUnderDepth !== null) {
        if (depth > skipUnderDepth) continue;
        skipUnderDepth = null;
      }

      const task = taskById.get(id);
      const scheduled = result.tasks.get(id);
      if (!task || !scheduled) continue;

      const hasChildren = wbs.isSummary(id);
      const collapsed = hasChildren && task.collapsed === true;
      if (collapsed) skipUnderDepth = depth;

      const rowIndex = visible.length;
      const isMilestone = scheduled.kind === 'milestone';

      visible.push({
        task,
        scheduled,
        rowIndex,
        depth,
        hasChildren,
        collapsed,
        color: colors.colorOf(task),
        bar: isMilestone ? null : barBox(scale, metrics, scheduled, rowIndex),
        diamond: isMilestone ? diamondBox(scale, metrics, scheduled.start, rowIndex) : null,
        baseline: showBaseline
          ? mapBaseline(baseline, id, scale, metrics, rowIndex)
          : null,
      });
    }

    return visible;
  }, [
    result,
    wbs,
    taskById,
    colors,
    scale,
    metrics,
    baseline,
    project.settings.showBaseline,
  ]);

  const rowByTaskId = useMemo(() => {
    const map = new Map<string, GanttRow>();
    for (const row of rows) map.set(row.task.id, row);
    return map;
  }, [rows]);

  const arrows = useMemo(() => {
    const drawn: GanttArrow[] = [];
    for (const dep of project.dependencies) {
      // A link into or out of a collapsed subtree has no bar to attach to. Rather than
      // draw a dangling arrow, redirect it to the visible ancestor's summary bar.
      const from = visibleAnchor(dep.predecessorId, rowByTaskId, wbs);
      const to = visibleAnchor(dep.successorId, rowByTaskId, wbs);
      if (!from || !to || from === to) continue;

      const fromBox = from.bar ?? from.diamond;
      const toBox = to.bar ?? to.diamond;
      if (!fromBox || !toBox) continue;

      drawn.push({
        dependency: dep,
        path: arrowPath({ type: dep.type, from: fromBox, to: toBox }),
        isCritical: result.criticalLinkIds.has(dep.id),
        isCyclic: result.cyclicDepIds.has(dep.id),
      });
    }
    return drawn;
  }, [project.dependencies, rowByTaskId, wbs, result]);

  /*
   * Memoised so the returned object keeps a stable identity between renders that did
   * not change anything. Without this, every consumer that watches `view` — including
   * `GanttChart`'s `onView` callback — sees a fresh object each render and re-runs,
   * which turns a parent holding the view in state into an infinite update loop.
   */
  return useMemo(
    () => ({
      result,
      wbs,
      calendar,
      scale,
      colors,
      rows,
      rowByTaskId,
      arrows,
      metrics,
      baseline,
      canvasHeight: rows.length * metrics.rowHeight,
      resourceNames,
    }),
    [
      result,
      wbs,
      calendar,
      scale,
      colors,
      rows,
      rowByTaskId,
      arrows,
      metrics,
      baseline,
      resourceNames,
    ],
  );
}

function mapBaseline(
  baseline: Baseline | null,
  taskId: string,
  scale: TimeScale,
  metrics: RowMetrics,
  rowIndex: number,
): BaselineBox | null {
  const bar = baselineBarOf(baseline, taskId);
  return bar ? baselineBox(scale, metrics, bar, rowIndex) : null;
}

/** The nearest ancestor that is actually on screen, for arrows into collapsed groups. */
function visibleAnchor(
  taskId: string,
  rowByTaskId: ReadonlyMap<string, GanttRow>,
  wbs: Wbs,
): GanttRow | null {
  let cursor: string | null = taskId;
  while (cursor !== null) {
    const row = rowByTaskId.get(cursor);
    if (row) return row;
    cursor = wbs.parentOf.get(cursor) ?? null;
  }
  return null;
}

/** Convenience for the today marker: `null` when today is off the current axis. */
export function todayX(scale: TimeScale, today: DayNum): number | null {
  if (today < scale.originDay || today > scale.lastDay) return null;
  return scale.xOf(today);
}
