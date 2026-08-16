/**
 * The working calendar.
 *
 * Duration in Ganttor is measured in *working* days: a 5-day task starting Monday
 * finishes Friday, and a task never starts or ends on a weekend or holiday. Every
 * date calculation in the engine routes through a `CompiledCalendar`, which is the
 * single place that knows which days are workable.
 *
 * Bound-snapping direction matters and is explicit. A *lower* bound (earliest
 * start) that lands on a non-working day must move forward — `ceilShift`. An
 * *upper* bound (latest finish) must move backward — `floorShift`. Getting this
 * backwards is how schedulers end up one day off in the presence of weekends.
 */

import { toDayNum, weekdayOf, type DayNum, type ISODate, type Weekday } from './day.js';

/** Which weekdays are workable, plus dates that are non-working regardless of weekday. */
export interface WorkCalendar {
  /** Indexed by weekday: 0 = Sunday … 6 = Saturday. `true` means workable. */
  workweek: readonly [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
  /** Non-working dates (public holidays, shutdowns) as `YYYY-MM-DD`. */
  holidays: readonly ISODate[];
}

/** Monday–Friday, no holidays. */
export const DEFAULT_CALENDAR: WorkCalendar = {
  workweek: [false, true, true, true, true, true, false],
  holidays: [],
};

/** A calendar where every day is workable — useful for tests and for plain-day projects. */
export const ALL_DAYS_CALENDAR: WorkCalendar = {
  workweek: [true, true, true, true, true, true, true],
  holidays: [],
};

export interface CompiledCalendar {
  readonly source: WorkCalendar;
  readonly workingDaysPerWeek: number;

  isWorkingDay(day: DayNum): boolean;
  /** `day` if workable, else the next workable day after it. */
  snapForward(day: DayNum): DayNum;
  /** `day` if workable, else the last workable day before it. */
  snapBack(day: DayNum): DayNum;

  /**
   * Shift by `n` working days, snapping a non-working `day` *forward* first.
   * Use for lower bounds (earliest start / earliest finish). `n` may be negative.
   */
  ceilShift(day: DayNum, n: number): DayNum;
  /**
   * Shift by `n` working days, snapping a non-working `day` *backward* first.
   * Use for upper bounds (latest start / latest finish). `n` may be negative.
   */
  floorShift(day: DayNum, n: number): DayNum;

  /** Inclusive count of working days in `[from, to]`. 0 when `to < from`. */
  workingDaysBetween(from: DayNum, to: DayNum): number;
  /**
   * Signed number of working-day steps from `from` to `to`, both assumed workable.
   * Same day → 0. Next working day → 1. Previous working day → -1.
   */
  workingDayDelta(from: DayNum, to: DayNum): number;

  /** Inclusive last working day of a task starting at `start` with `duration` working days. */
  endFromStart(start: DayNum, duration: number): DayNum;
  /** Start of a task finishing at `end` with `duration` working days. */
  startFromEnd(end: DayNum, duration: number): DayNum;
}

/** Guards against runaway loops if a calendar somehow has no workable day. */
const MAX_SNAP_STEPS = 400;

export function compileCalendar(source: WorkCalendar): CompiledCalendar {
  const workweek = source.workweek;
  const workingDaysPerWeek = workweek.filter(Boolean).length;
  if (workingDaysPerWeek === 0) {
    throw new RangeError('A work calendar must have at least one working weekday.');
  }

  const holidays = new Set<DayNum>();
  for (const iso of source.holidays) holidays.add(toDayNum(iso));

  const isWorkingDay = (day: DayNum): boolean =>
    workweek[weekdayOf(day) as Weekday] === true && !holidays.has(day);

  const step = (day: DayNum, dir: 1 | -1): DayNum => {
    let d = day;
    for (let i = 0; i < MAX_SNAP_STEPS; i++) {
      d += dir;
      if (isWorkingDay(d)) return d;
    }
    throw new RangeError(
      `No working day found within ${MAX_SNAP_STEPS} days of ${day}; the holiday list is likely wrong.`,
    );
  };

  const snapForward = (day: DayNum): DayNum => (isWorkingDay(day) ? day : step(day, 1));
  const snapBack = (day: DayNum): DayNum => (isWorkingDay(day) ? day : step(day, -1));

  const shift = (day: DayNum, n: number, snap: (d: DayNum) => DayNum): DayNum => {
    let d = snap(day);
    const dir: 1 | -1 = n >= 0 ? 1 : -1;
    for (let k = Math.abs(n); k > 0; k--) d = step(d, dir);
    return d;
  };

  const ceilShift = (day: DayNum, n: number): DayNum => shift(day, n, snapForward);
  const floorShift = (day: DayNum, n: number): DayNum => shift(day, n, snapBack);

  const workingDaysBetween = (from: DayNum, to: DayNum): number => {
    if (to < from) return 0;
    // Whole weeks contribute a constant, so only the remainder needs iterating.
    const wholeWeeks = Math.floor((to - from + 1) / 7);
    let count = wholeWeeks * workingDaysPerWeek;
    for (let d = from + wholeWeeks * 7; d <= to; d++) {
      if (workweek[weekdayOf(d) as Weekday] === true) count++;
    }
    // Whole-week counting ignores holidays, so subtract the ones actually in range.
    for (const h of holidays) {
      if (h >= from && h <= to && workweek[weekdayOf(h) as Weekday] === true) count--;
    }
    return count;
  };

  const workingDayDelta = (from: DayNum, to: DayNum): number =>
    to >= from ? workingDaysBetween(from, to) - 1 : -(workingDaysBetween(to, from) - 1);

  const endFromStart = (start: DayNum, duration: number): DayNum =>
    ceilShift(start, Math.max(duration, 1) - 1);

  const startFromEnd = (end: DayNum, duration: number): DayNum =>
    floorShift(end, -(Math.max(duration, 1) - 1));

  return {
    source,
    workingDaysPerWeek,
    isWorkingDay,
    snapForward,
    snapBack,
    ceilShift,
    floorShift,
    workingDaysBetween,
    workingDayDelta,
    endFromStart,
    startFromEnd,
  };
}
