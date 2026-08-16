/**
 * Baselines: the schedule you promised, kept next to the schedule you have.
 *
 * CRITERIA's test is integrity — *edit a task after saving a baseline and the original
 * bar must not move*. The only reliable way to guarantee that is to make the snapshot
 * genuinely immutable rather than to be careful about not writing to it, so
 * `createBaseline` deep-freezes what it returns. An accidental write throws in strict
 * mode instead of quietly corrupting the comparison.
 */

import type { CompiledCalendar } from './calendar.js';
import type { DayNum } from './day.js';
import type { Baseline, BaselineBar, ScheduleResult, ScheduledTask } from './types.js';

export interface CreateBaselineInput {
  id: string;
  name: string;
  /** ISO timestamp from the caller — the engine never reads the clock. */
  savedAt: string;
  result: ScheduleResult;
}

export function createBaseline(input: CreateBaselineInput): Baseline {
  const bars: Record<string, BaselineBar> = {};
  for (const task of input.result.tasks.values()) {
    bars[task.id] = Object.freeze({
      start: task.start,
      end: task.end,
      durationDays: task.durationDays,
      percentComplete: task.percentComplete,
    });
  }
  return Object.freeze({
    id: input.id,
    name: input.name,
    savedAt: input.savedAt,
    bars: Object.freeze(bars),
  });
}

export interface Variance {
  /** Working days the start moved. Positive is later than baseline. */
  startDelta: number;
  endDelta: number;
  durationDelta: number;
  progressDelta: number;
  /** True when the task now finishes later than it was promised to. */
  isSlipping: boolean;
}

export function computeVariance(
  calendar: CompiledCalendar,
  baselineBar: BaselineBar | undefined,
  scheduled: Pick<ScheduledTask, 'start' | 'end' | 'durationDays' | 'percentComplete'>,
): Variance | null {
  if (!baselineBar) return null;
  const endDelta = calendar.workingDayDelta(baselineBar.end, scheduled.end);
  return {
    startDelta: calendar.workingDayDelta(baselineBar.start, scheduled.start),
    endDelta,
    durationDelta: scheduled.durationDays - baselineBar.durationDays,
    progressDelta: scheduled.percentComplete - baselineBar.percentComplete,
    isSlipping: endDelta > 0,
  };
}

/** Total working days of slip against a baseline, summed over tasks that moved later. */
export function totalSlip(
  calendar: CompiledCalendar,
  baseline: Baseline,
  result: ScheduleResult,
): number {
  let slip = 0;
  for (const task of result.tasks.values()) {
    const variance = computeVariance(calendar, baseline.bars[task.id], task);
    if (variance && variance.endDelta > 0) slip += variance.endDelta;
  }
  return slip;
}

/** Convenience for the timeline renderer: the baseline bar for a task, if any. */
export function baselineBarOf(
  baseline: Baseline | null | undefined,
  taskId: string,
): { start: DayNum; end: DayNum } | null {
  const bar = baseline?.bars[taskId];
  return bar ? { start: bar.start, end: bar.end } : null;
}
