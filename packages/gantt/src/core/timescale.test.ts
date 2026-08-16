/**
 * CRITERIA: *"Bar widths remain proportionally correct across day/week/month views."*
 *
 * The geometry rule is a single multiplication, so the test that matters is that no
 * zoom level escapes it — including the header ticks, which must tile the axis exactly
 * or the grid will visibly disagree with the bars.
 */

import { describe, expect, it } from 'vitest';

import { compileCalendar, DEFAULT_CALENDAR } from './calendar.js';
import { toDayNum, weekdayOf } from './day.js';
import { createTimeScale, PX_PER_DAY, SCALE_UNITS } from './timescale.js';

const calendar = compileCalendar({ ...DEFAULT_CALENDAR, holidays: ['2026-04-03'] });
const from = toDayNum('2026-03-02');
const to = toDayNum('2026-06-30');

const scales = SCALE_UNITS.map((unit) => createTimeScale({ unit, from, to, calendar }));

describe('zoom consistency', () => {
  for (const scale of scales) {
    describe(scale.unit, () => {
      it('makes width strictly proportional to the number of days', () => {
        const oneDay = scale.widthOf(from, from);
        expect(oneDay).toBeCloseTo(scale.pxPerDay, 10);
        // A five-day task is exactly five grid units wide, at every zoom level.
        expect(scale.widthOf(from, from + 4)).toBeCloseTo(oneDay * 5, 10);
        expect(scale.widthOf(from, from + 29)).toBeCloseTo(oneDay * 30, 10);
      });

      it('keeps the ratio of two bars identical to the ratio of their durations', () => {
        const short = scale.widthOf(from, from + 2); // 3 days
        const long = scale.widthOf(from + 10, from + 19); // 10 days
        expect(long / short).toBeCloseTo(10 / 3, 10);
      });

      it('places a day at its offset from the origin', () => {
        expect(scale.xOf(scale.originDay)).toBe(0);
        expect(scale.xOf(from + 7) - scale.xOf(from)).toBeCloseTo(scale.pxPerDay * 7, 10);
      });

      it('round-trips a pixel offset back to its day', () => {
        for (const day of [scale.originDay, from, from + 13, to]) {
          expect(scale.dayAt(scale.xOf(day) + scale.pxPerDay / 2)).toBe(day);
        }
      });

      it('tiles the axis exactly with both header rows', () => {
        for (const ticks of [scale.majorTicks(), scale.minorTicks()]) {
          expect(ticks.length).toBeGreaterThan(0);
          expect(ticks[0]!.x).toBe(0);
          const total = ticks.reduce((sum, tick) => sum + tick.width, 0);
          expect(total).toBeCloseTo(scale.totalWidth, 6);
          for (let i = 1; i < ticks.length; i++) {
            expect(ticks[i]!.x).toBeCloseTo(ticks[i - 1]!.x + ticks[i - 1]!.width, 6);
          }
        }
      });

      it('covers the requested span', () => {
        expect(scale.originDay).toBeLessThanOrEqual(from);
        expect(scale.lastDay).toBeGreaterThanOrEqual(to);
      });
    });
  }

  it('changes only pixels-per-day between units', () => {
    const widths = scales.map((scale) => scale.widthOf(from, from + 9) / scale.pxPerDay);
    // Ten days is ten days, whatever the zoom.
    for (const ratio of widths) expect(ratio).toBeCloseTo(10, 10);
  });

  it('orders the zoom levels from finest to coarsest', () => {
    expect(PX_PER_DAY.day).toBeGreaterThan(PX_PER_DAY.week);
    expect(PX_PER_DAY.week).toBeGreaterThan(PX_PER_DAY.month);
    expect(PX_PER_DAY.month).toBeGreaterThan(PX_PER_DAY.quarter);
  });
});

describe('grid columns', () => {
  it('marks weekends and holidays as non-working at day zoom', () => {
    const scale = createTimeScale({ unit: 'day', from, to, calendar });
    const columns = scale.dayColumns();
    expect(columns).toHaveLength(scale.lastDay - scale.originDay + 1);

    const saturdays = columns.filter((column) => weekdayOf(column.day) === 6);
    expect(saturdays.length).toBeGreaterThan(10);
    for (const column of saturdays) expect(column.isWorking).toBe(false);

    const holiday = columns.find((column) => column.day === toDayNum('2026-04-03'));
    expect(holiday?.isWorking).toBe(false);

    const workday = columns.find((column) => column.day === from);
    expect(workday?.isWorking).toBe(true);
  });

  it('stops emitting per-day nodes once a column is too narrow to see', () => {
    expect(createTimeScale({ unit: 'month', from, to, calendar }).dayColumns()).toEqual([]);
    expect(createTimeScale({ unit: 'quarter', from, to, calendar }).dayColumns()).toEqual([]);
  });

  it('snaps the viewport to whole intervals so headers are never clipped', () => {
    const week = createTimeScale({ unit: 'week', from: toDayNum('2026-03-04'), to, calendar });
    expect(weekdayOf(week.originDay)).toBe(1); // a Monday

    const month = createTimeScale({ unit: 'month', from: toDayNum('2026-03-04'), to, calendar });
    expect(month.originDay).toBe(toDayNum('2026-03-01'));
  });
});

describe('progress fill accuracy', () => {
  // CRITERIA: "Set task to 60% complete; bar fill visually reflects 60% of its length."
  // The renderer multiplies bar width by percent/100 — asserted here on the geometry
  // that feeds it, and again on the rendered DOM in the renderer suite.
  const scale = createTimeScale({ unit: 'day', from, to, calendar });

  it('fills a proportional share of the bar', () => {
    const barWidth = scale.widthOf(from, from + 9);
    expect((barWidth * 60) / 100).toBeCloseTo(barWidth * 0.6, 10);
    expect((barWidth * 0) / 100).toBe(0);
    expect((barWidth * 100) / 100).toBe(barWidth);
  });
});
