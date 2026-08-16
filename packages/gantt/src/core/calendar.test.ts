import { describe, expect, it } from 'vitest';

import { ALL_DAYS_CALENDAR, compileCalendar, DEFAULT_CALENDAR } from './calendar.js';
import { toDayNum, toISO, weekdayOf } from './day.js';

const d = toDayNum;
const cal = compileCalendar(DEFAULT_CALENDAR);

// 2026-03-02 is a Monday; the whole suite is anchored to that week.
const MON = d('2026-03-02');
const FRI = d('2026-03-06');
const SAT = d('2026-03-07');
const SUN = d('2026-03-08');
const NEXT_MON = d('2026-03-09');

describe('day numbers', () => {
  it('round-trips ISO dates', () => {
    for (const iso of ['1970-01-01', '2026-03-02', '2026-12-31', '1999-02-28']) {
      expect(toISO(toDayNum(iso))).toBe(iso);
    }
  });

  it('derives the weekday without constructing a Date', () => {
    expect(weekdayOf(d('1970-01-01'))).toBe(4); // a Thursday
    expect(weekdayOf(MON)).toBe(1);
    expect(weekdayOf(SAT)).toBe(6);
    expect(weekdayOf(SUN)).toBe(0);
    expect(weekdayOf(d('1969-12-31'))).toBe(3); // negative day numbers still work
  });

  it('rejects anything that is not an ISO date', () => {
    expect(() => toDayNum('02/03/2026')).toThrow();
    expect(() => toDayNum('2026-13-01')).toThrow();
  });
});

describe('working calendar', () => {
  it('treats weekends as non-working', () => {
    expect(cal.isWorkingDay(FRI)).toBe(true);
    expect(cal.isWorkingDay(SAT)).toBe(false);
    expect(cal.isWorkingDay(SUN)).toBe(false);
  });

  it('snaps a lower bound forward and an upper bound backward', () => {
    expect(cal.snapForward(SAT)).toBe(NEXT_MON);
    expect(cal.snapBack(SAT)).toBe(FRI);
    // The direction only matters for a non-working input.
    expect(cal.snapForward(FRI)).toBe(FRI);
    expect(cal.snapBack(FRI)).toBe(FRI);
  });

  it('steps over the weekend', () => {
    expect(cal.ceilShift(FRI, 1)).toBe(NEXT_MON);
    expect(cal.ceilShift(MON, 5)).toBe(NEXT_MON);
    expect(cal.floorShift(NEXT_MON, -1)).toBe(FRI);
  });

  it('counts working days inclusively', () => {
    expect(cal.workingDaysBetween(MON, FRI)).toBe(5);
    expect(cal.workingDaysBetween(MON, SUN)).toBe(5); // the weekend adds nothing
    expect(cal.workingDaysBetween(MON, MON)).toBe(1);
    expect(cal.workingDaysBetween(FRI, MON)).toBe(0); // reversed range
    expect(cal.workingDaysBetween(MON, d('2026-03-13'))).toBe(10);
  });

  it('measures signed distance in working-day steps', () => {
    expect(cal.workingDayDelta(MON, MON)).toBe(0);
    expect(cal.workingDayDelta(FRI, NEXT_MON)).toBe(1);
    expect(cal.workingDayDelta(NEXT_MON, FRI)).toBe(-1);
    expect(cal.workingDayDelta(MON, FRI)).toBe(4);
  });

  it('derives an inclusive end from a start and duration', () => {
    expect(cal.endFromStart(MON, 1)).toBe(MON);
    expect(cal.endFromStart(MON, 5)).toBe(FRI);
    expect(cal.endFromStart(FRI, 3)).toBe(d('2026-03-10')); // Fri, then Mon and Tue
    // A milestone's end is its start.
    expect(cal.endFromStart(MON, 0)).toBe(MON);
  });

  it('derives a start from an end and duration', () => {
    expect(cal.startFromEnd(FRI, 5)).toBe(MON);
    expect(cal.startFromEnd(FRI, 1)).toBe(FRI);
    expect(cal.startFromEnd(NEXT_MON, 2)).toBe(FRI);
  });

  it('skips holidays as well as weekends', () => {
    const withHoliday = compileCalendar({
      ...DEFAULT_CALENDAR,
      holidays: ['2026-03-04'], // the Wednesday
    });
    expect(withHoliday.isWorkingDay(d('2026-03-04'))).toBe(false);
    // A five-day task now runs Mon–Mon rather than Mon–Fri.
    expect(withHoliday.endFromStart(MON, 5)).toBe(NEXT_MON);
    expect(withHoliday.workingDaysBetween(MON, FRI)).toBe(4);
  });

  it('supports a seven-day calendar for plain-day projects', () => {
    const all = compileCalendar(ALL_DAYS_CALENDAR);
    expect(all.isWorkingDay(SAT)).toBe(true);
    expect(all.endFromStart(MON, 5)).toBe(FRI);
    expect(all.endFromStart(FRI, 3)).toBe(SUN);
  });

  it('refuses a calendar with no working weekday', () => {
    expect(() =>
      compileCalendar({ workweek: [false, false, false, false, false, false, false], holidays: [] }),
    ).toThrow(/at least one working weekday/);
  });
});
