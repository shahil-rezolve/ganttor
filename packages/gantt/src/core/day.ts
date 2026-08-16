/**
 * Integer day arithmetic.
 *
 * Every date in Ganttor is a `DayNum` — a count of days since 1970-01-01. All
 * scheduling math is integer addition on that number. `Date` objects appear only
 * at the boundaries of this module, and never in the engine, which removes
 * timezones, DST, and floating-point drift from the entire scheduling problem.
 */

/** Days since 1970-01-01. Day 0 is a Thursday. */
export type DayNum = number;

/** Calendar date as `YYYY-MM-DD`. The only date format Ganttor persists. */
export type ISODate = string;

const MS_PER_DAY = 86_400_000;

/** 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toDayNum(iso: ISODate): DayNum {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) throw new RangeError(`Not an ISO date (YYYY-MM-DD): ${JSON.stringify(iso)}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError(`Date out of range: ${iso}`);
  }
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

export function toISO(day: DayNum): ISODate {
  const d = new Date(day * MS_PER_DAY);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Weekday of a day number, without constructing a Date.
 * 1970-01-01 (day 0) was a Thursday, so the offset is 4.
 */
export function weekdayOf(day: DayNum): Weekday {
  return (((day % 7) + 11) % 7) as Weekday;
}

/** Today in the viewer's local timezone. Impure — UI only, never the engine. */
export function todayDayNum(now: Date = new Date()): DayNum {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY);
}

/** Start of the ISO-ish week containing `day`. `weekStartsOn` defaults to Monday. */
export function startOfWeek(day: DayNum, weekStartsOn: Weekday = 1): DayNum {
  const delta = (weekdayOf(day) - weekStartsOn + 7) % 7;
  return day - delta;
}

export function startOfMonth(day: DayNum): DayNum {
  const d = new Date(day * MS_PER_DAY);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / MS_PER_DAY);
}

export function startOfQuarter(day: DayNum): DayNum {
  const d = new Date(day * MS_PER_DAY);
  const q = Math.floor(d.getUTCMonth() / 3) * 3;
  return Math.floor(Date.UTC(d.getUTCFullYear(), q, 1) / MS_PER_DAY);
}

export function startOfYear(day: DayNum): DayNum {
  const d = new Date(day * MS_PER_DAY);
  return Math.floor(Date.UTC(d.getUTCFullYear(), 0, 1) / MS_PER_DAY);
}

export function addMonths(day: DayNum, months: number): DayNum {
  const d = new Date(day * MS_PER_DAY);
  return Math.floor(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()) / MS_PER_DAY,
  );
}

export interface DayParts {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
  weekday: Weekday;
  /** 1–4. */
  quarter: number;
}

export function partsOf(day: DayNum): DayParts {
  const d = new Date(day * MS_PER_DAY);
  const month = d.getUTCMonth() + 1;
  return {
    year: d.getUTCFullYear(),
    month,
    day: d.getUTCDate(),
    weekday: weekdayOf(day),
    quarter: Math.floor((month - 1) / 3) + 1,
  };
}

/** ISO-8601 week number, used by the week-scale header. */
export function isoWeekNumber(day: DayNum): number {
  // Thursday of the current ISO week determines the year the week belongs to.
  const thursday = startOfWeek(day, 1) + 3;
  const jan1 = startOfYear(thursday);
  return Math.floor((thursday - jan1) / 7) + 1;
}
