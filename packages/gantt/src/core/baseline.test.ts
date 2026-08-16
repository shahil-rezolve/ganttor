/**
 * CRITERIA: *"Edit a task after baseline save; original baseline bar remains unchanged."*
 */

import { describe, expect, it } from 'vitest';

import { baselineBarOf, computeVariance, createBaseline, totalSlip } from './baseline.js';
import { compileCalendar, DEFAULT_CALENDAR } from './calendar.js';
import { saveBaseline, updateTask } from './project.js';
import { schedule } from './schedule.js';
import { buildProject, KIT_START, workingDayIndexer } from '../fixtures/kit.js';

const wd = workingDayIndexer(KIT_START);
const cal = compileCalendar(DEFAULT_CALENDAR);

const base = buildProject({
  tasks: [
    { id: 'A', dur: 4, pct: 25 },
    { id: 'B', dur: 3 },
  ],
  deps: [['A', 'B']],
});

const baseline = createBaseline({
  id: 'b1',
  name: 'Original plan',
  savedAt: '2026-03-02T09:00:00.000Z',
  result: schedule(base),
});

describe('baseline integrity', () => {
  it('captures the schedule as it stood', () => {
    expect(baseline.bars['A']).toEqual({
      start: wd(0),
      end: wd(3),
      durationDays: 4,
      percentComplete: 25,
    });
  });

  it('does not move when the live task is edited', () => {
    const withBaseline = saveBaseline(base, baseline);
    const edited = updateTask(withBaseline, 'A', {
      durationDays: 9,
      constraint: { type: 'SNET', day: wd(5) },
      percentComplete: 80,
    });

    const after = schedule(edited);
    expect(after.tasks.get('A')!.start).toBe(wd(5));
    expect(after.tasks.get('A')!.durationDays).toBe(9);

    // The stored snapshot is byte-identical to what was captured.
    expect(edited.baselines[0]!.bars['A']).toEqual({
      start: wd(0),
      end: wd(3),
      durationDays: 4,
      percentComplete: 25,
    });
  });

  it('is frozen, so an accidental write throws instead of corrupting the comparison', () => {
    expect(Object.isFrozen(baseline)).toBe(true);
    expect(Object.isFrozen(baseline.bars)).toBe(true);
    expect(Object.isFrozen(baseline.bars['A'])).toBe(true);
    expect(() => {
      (baseline.bars['A'] as { start: number }).start = 0;
    }).toThrow();
  });
});

describe('baseline variance', () => {
  const slipped = updateTask(base, 'A', {
    durationDays: 6,
    percentComplete: 40,
  });
  const after = schedule(slipped);

  it('reports how far a task moved, in working days', () => {
    const variance = computeVariance(cal, baseline.bars['A'], after.tasks.get('A')!)!;
    expect(variance).toEqual({
      startDelta: 0,
      endDelta: 2,
      durationDelta: 2,
      progressDelta: 15,
      isSlipping: true,
    });
  });

  it('propagates slip to successors', () => {
    const variance = computeVariance(cal, baseline.bars['B'], after.tasks.get('B')!)!;
    expect(variance.startDelta).toBe(2);
    expect(variance.endDelta).toBe(2);
    expect(variance.durationDelta).toBe(0);
  });

  it('sums slip across the project', () => {
    expect(totalSlip(cal, baseline, after)).toBe(4);
  });

  it('returns nothing for a task the baseline never saw', () => {
    expect(computeVariance(cal, undefined, after.tasks.get('A')!)).toBeNull();
    expect(baselineBarOf(baseline, 'ghost')).toBeNull();
    expect(baselineBarOf(null, 'A')).toBeNull();
  });

  it('exposes the ghost bar the renderer draws', () => {
    expect(baselineBarOf(baseline, 'A')).toEqual({ start: wd(0), end: wd(3) });
  });
});
