/**
 * The start / end / duration triangle.
 *
 * CRITERIA: *changing any one of these two should auto-recalculate the third.* Which
 * of the other two moves is a decision, not a detail, so it is written down once here
 * and every editing path — inline field, bar drag, bar resize — goes through it:
 *
 * | Edited   | Held     | Recomputed |
 * |----------|----------|------------|
 * | start    | duration | end        |
 * | end      | start    | duration   |
 * | duration | start    | end        |
 *
 * Duration is inclusive and counted in working days: a 1-day task starts and ends on
 * the same day, and a 5-day task starting Monday ends Friday. A milestone has
 * duration 0 and its start always equals its end.
 */

import type { CompiledCalendar } from './calendar.js';
import type { DayNum } from './day.js';

export interface TaskDates {
  start: DayNum;
  /** Inclusive. */
  end: DayNum;
  /** Working days. 0 means milestone. */
  durationDays: number;
}

/** Move the start; hold duration; the end follows. */
export function editStart(
  calendar: CompiledCalendar,
  current: TaskDates,
  newStart: DayNum,
): TaskDates {
  const start = calendar.snapForward(newStart);
  return {
    start,
    end: calendar.endFromStart(start, current.durationDays),
    durationDays: current.durationDays,
  };
}

/** Move the end; hold the start; duration is re-measured. */
export function editEnd(
  calendar: CompiledCalendar,
  current: TaskDates,
  newEnd: DayNum,
): TaskDates {
  if (current.durationDays === 0) {
    // A milestone has no end to drag independently; moving it moves the marker.
    return editStart(calendar, current, newEnd);
  }
  const end = calendar.snapBack(newEnd);
  if (end < current.start) {
    // Dragging the end past the start collapses to a one-day task rather than
    // producing a negative duration.
    return { start: current.start, end: current.start, durationDays: 1 };
  }
  return {
    start: current.start,
    end,
    durationDays: calendar.workingDaysBetween(current.start, end),
  };
}

/** Set duration; hold the start; the end follows. */
export function editDuration(
  calendar: CompiledCalendar,
  current: TaskDates,
  newDuration: number,
): TaskDates {
  const durationDays = Math.max(0, Math.floor(newDuration));
  const start = calendar.snapForward(current.start);
  return {
    start,
    end: calendar.endFromStart(start, durationDays),
    durationDays,
  };
}

/** Shift a whole bar by a number of calendar days, preserving its duration. */
export function shiftBy(
  calendar: CompiledCalendar,
  current: TaskDates,
  calendarDays: number,
): TaskDates {
  return editStart(calendar, current, current.start + calendarDays);
}
