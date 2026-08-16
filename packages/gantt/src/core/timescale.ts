/**
 * Mapping days to pixels.
 *
 * CRITERIA asks that bar widths stay proportionally correct across day, week, month,
 * and quarter views. That is guaranteed here by construction rather than by testing
 * four separate code paths: there is exactly one geometry rule,
 *
 * ```
 * widthOf(start, end) === (end − start + 1) × pxPerDay
 * xOf(day)            === (day − originDay) × pxPerDay
 * ```
 *
 * and the zoom unit changes only `pxPerDay` and the granularity of the header ticks.
 * No bar geometry is special-cased per unit, so proportionality cannot drift between
 * views.
 *
 * Bars live on the *calendar* axis while durations count working days. A Monday-start
 * five-working-day task therefore occupies the Mon–Fri columns, and a task spanning a
 * weekend is visibly wider than its duration — correct, and what MS Project does. The
 * weekend columns are shaded so the widening reads as non-working time rather than as
 * a measurement error.
 */

import type { CompiledCalendar } from './calendar.js';
import {
  addMonths,
  isoWeekNumber,
  partsOf,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  type DayNum,
  type Weekday,
} from './day.js';

export type ScaleUnit = 'day' | 'week' | 'month' | 'quarter';

export const SCALE_UNITS: readonly ScaleUnit[] = ['day', 'week', 'month', 'quarter'];

/**
 * Column width per unit. These are the *only* numbers that change between zoom
 * levels; everything else is derived.
 */
export const PX_PER_DAY: Record<ScaleUnit, number> = {
  day: 34,
  week: 12,
  month: 4.2,
  quarter: 1.6,
};

export const SCALE_LABELS: Record<ScaleUnit, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  quarter: 'Quarter',
};

export interface Tick {
  /** First day of the interval this tick covers. */
  day: DayNum;
  x: number;
  width: number;
  label: string;
}

export interface DayColumn {
  day: DayNum;
  x: number;
  width: number;
  isWorking: boolean;
  isMonthStart: boolean;
  isWeekStart: boolean;
}

export interface TimeScale {
  unit: ScaleUnit;
  pxPerDay: number;
  /** Leftmost day rendered. */
  originDay: DayNum;
  /** Rightmost day rendered, inclusive. */
  lastDay: DayNum;
  totalWidth: number;
  /** Left edge of a day's column. */
  xOf(day: DayNum): number;
  /** Centre of a day's column — where a milestone diamond and the today line sit. */
  centerOf(day: DayNum): number;
  /** Width of an inclusive day span. */
  widthOf(start: DayNum, end: DayNum): number;
  /** Which day a pixel offset falls in. */
  dayAt(x: number): DayNum;
  /** Coarse header row: month, quarter, or year depending on unit. */
  majorTicks(): Tick[];
  /** Fine header row: day, week, month, or quarter depending on unit. */
  minorTicks(): Tick[];
  /**
   * Per-day background columns for weekend and holiday shading. Empty when the unit
   * is too coarse for a day to be worth its own DOM node.
   */
  dayColumns(): DayColumn[];
}

export interface TimeScaleOptions {
  unit: ScaleUnit;
  /** Project span to cover; padded out to whole intervals. */
  from: DayNum;
  to: DayNum;
  calendar: CompiledCalendar;
  /** Extra calendar days of breathing room on each side. */
  padDays?: number;
  weekStartsOn?: Weekday;
  pxPerDayOverride?: number;
}

/** Below this column width, one DOM node per day stops paying for itself. */
const DAY_COLUMN_THRESHOLD = 6;

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function createTimeScale(options: TimeScaleOptions): TimeScale {
  const { unit, calendar, from, to } = options;
  const padDays = options.padDays ?? 0;
  const weekStartsOn = options.weekStartsOn ?? 1;
  const pxPerDay = options.pxPerDayOverride ?? PX_PER_DAY[unit];

  const paddedFrom = from - padDays;
  const paddedTo = Math.max(to + padDays, paddedFrom);

  // Snap the viewport to whole intervals so header cells are never clipped.
  const originDay = alignStart(paddedFrom, unit, weekStartsOn);
  const lastDay = alignEnd(paddedTo, unit, weekStartsOn);

  const xOf = (day: DayNum): number => (day - originDay) * pxPerDay;
  const widthOf = (start: DayNum, end: DayNum): number => (end - start + 1) * pxPerDay;
  const totalWidth = widthOf(originDay, lastDay);

  const scale: TimeScale = {
    unit,
    pxPerDay,
    originDay,
    lastDay,
    totalWidth,
    xOf,
    centerOf: (day) => xOf(day) + pxPerDay / 2,
    widthOf,
    dayAt: (x) => originDay + Math.floor(x / pxPerDay),

    majorTicks: () => {
      switch (unit) {
        case 'day':
        case 'week':
          return monthTicks(originDay, lastDay, xOf, widthOf, true);
        case 'month':
          return quarterTicks(originDay, lastDay, xOf, widthOf, true);
        case 'quarter':
          return yearTicks(originDay, lastDay, xOf, widthOf);
      }
    },

    minorTicks: () => {
      switch (unit) {
        case 'day':
          return dayTicks(originDay, lastDay, xOf, pxPerDay);
        case 'week':
          return weekTicks(originDay, lastDay, xOf, widthOf, weekStartsOn);
        case 'month':
          return monthTicks(originDay, lastDay, xOf, widthOf, false);
        case 'quarter':
          return quarterTicks(originDay, lastDay, xOf, widthOf, false);
      }
    },

    dayColumns: () => {
      if (pxPerDay < DAY_COLUMN_THRESHOLD) return [];
      const columns: DayColumn[] = [];
      for (let day = originDay; day <= lastDay; day++) {
        const parts = partsOf(day);
        columns.push({
          day,
          x: xOf(day),
          width: pxPerDay,
          isWorking: calendar.isWorkingDay(day),
          isMonthStart: parts.day === 1,
          isWeekStart: parts.weekday === weekStartsOn,
        });
      }
      return columns;
    },
  };

  return scale;
}

function alignStart(day: DayNum, unit: ScaleUnit, weekStartsOn: Weekday): DayNum {
  switch (unit) {
    case 'day':
      return day;
    case 'week':
      return startOfWeek(day, weekStartsOn);
    case 'month':
      return startOfMonth(day);
    case 'quarter':
      return startOfQuarter(day);
  }
}

function alignEnd(day: DayNum, unit: ScaleUnit, weekStartsOn: Weekday): DayNum {
  switch (unit) {
    case 'day':
      return day;
    case 'week':
      return startOfWeek(day, weekStartsOn) + 6;
    case 'month':
      return addMonths(startOfMonth(day), 1) - 1;
    case 'quarter':
      return addMonths(startOfQuarter(day), 3) - 1;
  }
}

type XOf = (day: DayNum) => number;
type WidthOf = (start: DayNum, end: DayNum) => number;

function dayTicks(origin: DayNum, last: DayNum, xOf: XOf, pxPerDay: number): Tick[] {
  const ticks: Tick[] = [];
  for (let day = origin; day <= last; day++) {
    const parts = partsOf(day);
    ticks.push({
      day,
      x: xOf(day),
      width: pxPerDay,
      label: `${WEEKDAY_INITIALS[parts.weekday]!}${parts.day}`,
    });
  }
  return ticks;
}

function weekTicks(
  origin: DayNum,
  last: DayNum,
  xOf: XOf,
  widthOf: WidthOf,
  weekStartsOn: Weekday,
): Tick[] {
  const ticks: Tick[] = [];
  for (let day = startOfWeek(origin, weekStartsOn); day <= last; day += 7) {
    const start = Math.max(day, origin);
    const end = Math.min(day + 6, last);
    ticks.push({
      day: start,
      x: xOf(start),
      width: widthOf(start, end),
      label: `W${isoWeekNumber(day)}`,
    });
  }
  return ticks;
}

function monthTicks(
  origin: DayNum,
  last: DayNum,
  xOf: XOf,
  widthOf: WidthOf,
  withYear: boolean,
): Tick[] {
  const ticks: Tick[] = [];
  for (let day = startOfMonth(origin); day <= last; day = addMonths(day, 1)) {
    const start = Math.max(day, origin);
    const end = Math.min(addMonths(day, 1) - 1, last);
    const parts = partsOf(day);
    ticks.push({
      day: start,
      x: xOf(start),
      width: widthOf(start, end),
      label: withYear
        ? `${MONTH_NAMES[parts.month - 1]!} ${parts.year}`
        : MONTH_NAMES[parts.month - 1]!,
    });
  }
  return ticks;
}

function quarterTicks(
  origin: DayNum,
  last: DayNum,
  xOf: XOf,
  widthOf: WidthOf,
  withYear: boolean,
): Tick[] {
  const ticks: Tick[] = [];
  for (let day = startOfQuarter(origin); day <= last; day = addMonths(day, 3)) {
    const start = Math.max(day, origin);
    const end = Math.min(addMonths(day, 3) - 1, last);
    const parts = partsOf(day);
    ticks.push({
      day: start,
      x: xOf(start),
      width: widthOf(start, end),
      label: withYear ? `Q${parts.quarter} ${parts.year}` : `Q${parts.quarter}`,
    });
  }
  return ticks;
}

function yearTicks(origin: DayNum, last: DayNum, xOf: XOf, widthOf: WidthOf): Tick[] {
  const ticks: Tick[] = [];
  for (let day = startOfYear(origin); day <= last; day = addMonths(day, 12)) {
    const start = Math.max(day, origin);
    const end = Math.min(addMonths(day, 12) - 1, last);
    ticks.push({
      day: start,
      x: xOf(start),
      width: widthOf(start, end),
      label: String(partsOf(day).year),
    });
  }
  return ticks;
}
