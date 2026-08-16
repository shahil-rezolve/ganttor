/**
 * The CRITERIA verification suite, part one: duration math, dependency propagation,
 * circular-dependency rejection, and milestone rendering.
 *
 * Each `describe` corresponds to a row of the table at the bottom of `CRITERIA.md`.
 * Expectations are written in working-day indices from the project start (`wd(n)`) so
 * they say what they mean instead of encoding a particular March.
 */

import { describe, expect, it } from 'vitest';

import { compileCalendar, DEFAULT_CALENDAR } from './calendar.js';
import { editDuration, editEnd, editStart } from './duration.js';
import { addDependency, pinTaskDates, updateTask } from './project.js';
import { findDependencyCycle, schedule } from './schedule.js';
import { buildProject, KIT_START, workingDayIndexer } from '../fixtures/kit.js';
import type { Project } from './types.js';

const wd = workingDayIndexer(KIT_START);
const cal = compileCalendar(DEFAULT_CALENDAR);

/** `[startIndex, endIndex]` of a task, in working days from the project start. */
function span(project: Project, id: string): [number, number] {
  const task = schedule(project).tasks.get(id);
  if (!task) throw new Error(`No scheduled task ${id}`);
  return [cal.workingDayDelta(wd(0), task.start), cal.workingDayDelta(wd(0), task.end)];
}

// ─────────────────────────────────────────────────────────────────────────────────
// CRITERIA: "Change start date → end date auto-updates by same duration"
// ─────────────────────────────────────────────────────────────────────────────────

describe('duration math', () => {
  const current = { start: wd(0), end: wd(4), durationDays: 5 };

  it('editing the start holds duration and moves the end', () => {
    const next = editStart(cal, current, wd(3));
    expect(next.durationDays).toBe(5);
    expect(next.start).toBe(wd(3));
    expect(next.end).toBe(wd(7));
  });

  it('editing the end holds the start and re-measures duration', () => {
    const next = editEnd(cal, current, wd(9));
    expect(next.start).toBe(wd(0));
    expect(next.end).toBe(wd(9));
    expect(next.durationDays).toBe(10);
  });

  it('editing the duration holds the start and moves the end', () => {
    const next = editDuration(cal, current, 3);
    expect(next.start).toBe(wd(0));
    expect(next.end).toBe(wd(2));
    expect(next.durationDays).toBe(3);
  });

  it('never lands a start or end on a weekend', () => {
    // wd(4) is a Friday; +1 calendar day is Saturday.
    const next = editStart(cal, current, wd(4) + 1);
    expect(next.start).toBe(wd(5));
    expect(cal.isWorkingDay(next.start)).toBe(true);
    expect(cal.isWorkingDay(next.end)).toBe(true);
  });

  it('collapses rather than inverting when the end is dragged before the start', () => {
    const next = editEnd(cal, current, wd(0) - 3);
    expect(next.start).toBe(wd(0));
    expect(next.end).toBe(wd(0));
    expect(next.durationDays).toBe(1);
  });

  it('routes a milestone end-drag into a move, since it has no length', () => {
    const milestone = { start: wd(2), end: wd(2), durationDays: 0 };
    const next = editEnd(cal, milestone, wd(6));
    expect(next).toEqual({ start: wd(6), end: wd(6), durationDays: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// CRITERIA: "Shift a predecessor → all successors reschedule correctly per type"
// ─────────────────────────────────────────────────────────────────────────────────

describe('dependency propagation', () => {
  const pair = (type: 'FS' | 'SS' | 'FF' | 'SF', lag = 0): Project =>
    buildProject({
      tasks: [
        { id: 'A', dur: 5 },
        { id: 'B', dur: 3 },
      ],
      deps: [['A', 'B', type, lag]],
    });

  it('finish-to-start starts the successor the next working day', () => {
    expect(span(pair('FS'), 'A')).toEqual([0, 4]);
    expect(span(pair('FS'), 'B')).toEqual([5, 7]);
  });

  it('start-to-start aligns the starts', () => {
    expect(span(pair('SS'), 'B')).toEqual([0, 2]);
  });

  it('finish-to-finish aligns the finishes, working the start backwards', () => {
    // B must finish no earlier than day 4, and is 3 days long, so it starts on day 2.
    expect(span(pair('FF'), 'B')).toEqual([2, 4]);
  });

  it('start-to-finish bounds the successor finish by the predecessor start', () => {
    // A starts on day 0, so B need only finish by then — the project start dominates.
    expect(span(pair('SF'), 'B')).toEqual([0, 2]);
  });

  it('applies positive lag as a delay in working days', () => {
    expect(span(pair('FS', 2), 'B')).toEqual([7, 9]);
    expect(span(pair('SS', 3), 'B')).toEqual([3, 5]);
    expect(span(pair('FF', 2), 'B')).toEqual([4, 6]);
  });

  it('applies negative lag as a lead, overlapping the tasks', () => {
    // Finish-to-start with a two-day lead: B starts two working days before A ends.
    expect(span(pair('FS', -2), 'B')).toEqual([3, 5]);
  });

  it('never schedules a successor before the project start, even with a large lead', () => {
    expect(span(pair('FS', -20), 'B')).toEqual([0, 2]);
  });

  it('takes the latest of several predecessors', () => {
    const project = buildProject({
      tasks: [
        { id: 'A', dur: 2 },
        { id: 'B', dur: 6 },
        { id: 'C', dur: 1 },
      ],
      deps: [
        ['A', 'C'],
        ['B', 'C'],
      ],
    });
    expect(span(project, 'C')).toEqual([6, 6]);
  });

  // This is CRITERIA's own worked example, verbatim.
  it('shifts a finish-to-start successor by exactly the delay applied to its predecessor', () => {
    const base = buildProject({
      tasks: [
        { id: 'A', dur: 4 },
        { id: 'B', dur: 3 },
      ],
      deps: [['A', 'B']],
    });
    expect(span(base, 'B')).toEqual([4, 6]);

    const delayed = updateTask(base, 'A', { constraint: { type: 'SNET', day: wd(3) } });
    expect(span(delayed, 'A')).toEqual([3, 6]);
    expect(span(delayed, 'B')).toEqual([7, 9]);
  });

  it('propagates through a chain, not just one hop', () => {
    const chain = buildProject({
      tasks: [
        { id: 'A', dur: 2 },
        { id: 'B', dur: 2 },
        { id: 'C', dur: 2 },
        { id: 'D', dur: 2 },
      ],
      deps: [
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'D'],
      ],
    });
    expect(span(chain, 'D')).toEqual([6, 7]);

    const delayed = updateTask(chain, 'A', { constraint: { type: 'SNET', day: wd(5) } });
    expect(span(delayed, 'D')).toEqual([11, 12]);
  });

  it('records which dependency actually set the dates', () => {
    const project = buildProject({
      tasks: [
        { id: 'early', dur: 1 },
        { id: 'late', dur: 6 },
        { id: 'target', dur: 1 },
      ],
      deps: [
        ['early', 'target'],
        ['late', 'target'],
      ],
    });
    const target = schedule(project).tasks.get('target')!;
    expect(target.bindingDepIds).toEqual(['d2']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// Dragging a bar: the constraint that stops it springing back
// ─────────────────────────────────────────────────────────────────────────────────

describe('dragging a bar', () => {
  it('holds its new position across a reschedule', () => {
    const project = buildProject({ tasks: [{ id: 'A', dur: 3 }] });
    expect(span(project, 'A')).toEqual([0, 2]);

    const dragged = pinTaskDates(project, 'A', { start: wd(6), end: wd(8), durationDays: 3 });
    // Scheduling is idempotent: a second pass must not slide the bar back to the
    // project start, which is the classic springs-back-on-release bug.
    expect(span(dragged, 'A')).toEqual([6, 8]);
    expect(span(dragged, 'A')).toEqual([6, 8]);
  });

  it('still yields to a predecessor when dragged too early', () => {
    const project = buildProject({
      tasks: [
        { id: 'A', dur: 5 },
        { id: 'B', dur: 2 },
      ],
      deps: [['A', 'B']],
    });
    const dragged = pinTaskDates(project, 'B', { start: wd(1), end: wd(2), durationDays: 2 });
    // The SNET is honoured as a floor, not as an override of the dependency.
    expect(span(dragged, 'B')).toEqual([5, 6]);
  });

  it('reports a must-start-on pin that its predecessors contradict', () => {
    const project = buildProject({
      tasks: [
        { id: 'A', dur: 5 },
        { id: 'B', dur: 2, mso: 1 },
      ],
      deps: [['A', 'B']],
    });
    const b = schedule(project).tasks.get('B')!;
    expect(span(project, 'B')).toEqual([1, 2]);
    expect(b.conflicts).toContain('constraint-violated');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// CRITERIA: "Attempt A→B→C→A link; app should block or warn"
// ─────────────────────────────────────────────────────────────────────────────────

describe('circular dependency rejection', () => {
  const abc = buildProject({
    tasks: [
      { id: 'A', dur: 2 },
      { id: 'B', dur: 2 },
      { id: 'C', dur: 2 },
    ],
    deps: [
      ['A', 'B'],
      ['B', 'C'],
    ],
  });

  it('refuses the closing link and names the path', () => {
    const result = addDependency(abc, { id: 'dx', predecessorId: 'C', successorId: 'A' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.cycle).toEqual(['C', 'A', 'B', 'C']);
    expect(result.reason).toMatch(/circular/i);
  });

  it('writes nothing when it refuses', () => {
    const before = abc.dependencies.length;
    addDependency(abc, { id: 'dx', predecessorId: 'C', successorId: 'A' });
    expect(abc.dependencies).toHaveLength(before);
  });

  it('allows links that merely converge', () => {
    const result = addDependency(abc, { id: 'dx', predecessorId: 'A', successorId: 'C' });
    expect(result.ok).toBe(true);
  });

  it('refuses a task depending on itself', () => {
    expect(addDependency(abc, { id: 'dx', predecessorId: 'A', successorId: 'A' }).ok).toBe(false);
    expect(findDependencyCycle(abc, { predecessorId: 'A', successorId: 'A' })).toEqual(['A', 'A']);
  });

  it('refuses a duplicate link', () => {
    expect(addDependency(abc, { id: 'dx', predecessorId: 'A', successorId: 'B' }).ok).toBe(false);
  });

  it('still schedules the rest of the project when imported data already loops', () => {
    // Imports are not validated by us, so a loop can arrive pre-made.
    const looped: Project = {
      ...abc,
      dependencies: [...abc.dependencies, { id: 'd3', predecessorId: 'C', successorId: 'A', type: 'FS', lagDays: 0 }],
      tasks: [...abc.tasks, { ...abc.tasks[0]!, id: 'D', name: 'D', parentId: null }],
    };
    const result = schedule(looped);

    expect(result.cyclicDepIds.size).toBe(1);
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]).toHaveLength(4);
    // Every task still has dates; the tool does not become unusable.
    expect(result.tasks.size).toBe(4);
    expect(result.tasks.get('D')!.conflicts).toEqual([]);
    for (const id of ['A', 'B', 'C']) {
      expect(result.tasks.get(id)!.conflicts).toContain('in-cycle');
    }
  });

  it('refuses a link between a task and its own parent', () => {
    const nested = buildProject({
      tasks: [
        { id: 'P', dur: 0 },
        { id: 'K', dur: 2, parent: 'P' },
      ],
    });
    expect(addDependency(nested, { id: 'dx', predecessorId: 'P', successorId: 'K' }).ok).toBe(false);
    expect(addDependency(nested, { id: 'dy', predecessorId: 'K', successorId: 'P' }).ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// CRITERIA: "Zero-duration task renders as a marker, not a bar"
// ─────────────────────────────────────────────────────────────────────────────────

describe('milestones', () => {
  it('has no length and is typed distinctly', () => {
    const project = buildProject({
      tasks: [
        { id: 'A', dur: 4 },
        { id: 'M', dur: 0 },
      ],
      deps: [['A', 'M']],
    });
    const milestone = schedule(project).tasks.get('M')!;
    expect(milestone.kind).toBe('milestone');
    expect(milestone.start).toBe(milestone.end);
    expect(milestone.durationDays).toBe(0);
    expect(span(project, 'A')).toEqual([0, 3]);
    expect(span(project, 'M')).toEqual([4, 4]);
  });

  it('keeps zero duration however far it is pushed', () => {
    const project = buildProject({
      tasks: [
        { id: 'A', dur: 4 },
        { id: 'M', dur: 0 },
      ],
      deps: [['A', 'M']],
    });
    const pushed = updateTask(project, 'A', { constraint: { type: 'SNET', day: wd(10) } });
    const milestone = schedule(pushed).tasks.get('M')!;
    expect(milestone.durationDays).toBe(0);
    expect(milestone.start).toBe(milestone.end);
    expect(span(pushed, 'A')).toEqual([10, 13]);
    expect(span(pushed, 'M')).toEqual([14, 14]);
  });

  it('propagates from a milestone like any other predecessor', () => {
    const project = buildProject({
      tasks: [
        { id: 'M', dur: 0, snet: 3 },
        { id: 'B', dur: 2 },
      ],
      deps: [['M', 'B']],
    });
    expect(span(project, 'B')).toEqual([4, 5]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// WBS rollups
// ─────────────────────────────────────────────────────────────────────────────────

describe('summary tasks', () => {
  const project = buildProject({
    tasks: [
      { id: 'P', dur: 99 },
      { id: 'K1', dur: 3, parent: 'P', pct: 100 },
      { id: 'K2', dur: 5, parent: 'P', pct: 20 },
      { id: 'After', dur: 2 },
    ],
    deps: [
      ['K1', 'K2'],
      ['P', 'After'],
    ],
  });

  it('spans its children and ignores its own stored duration', () => {
    expect(span(project, 'K1')).toEqual([0, 2]);
    expect(span(project, 'K2')).toEqual([3, 7]);
    expect(span(project, 'P')).toEqual([0, 7]);
    expect(schedule(project).tasks.get('P')!.kind).toBe('summary');
    expect(schedule(project).tasks.get('P')!.durationDays).toBe(8);
  });

  it('averages progress weighted by duration', () => {
    // (3 × 100 + 5 × 20) / 8 = 50
    expect(schedule(project).tasks.get('P')!.percentComplete).toBe(50);
  });

  it('can act as a predecessor, constraining against its rolled-up finish', () => {
    expect(span(project, 'After')).toEqual([8, 9]);
  });

  it('cannot act as a successor, and says so instead of half-applying the link', () => {
    const bad = buildProject({
      tasks: [
        { id: 'X', dur: 2 },
        { id: 'P', dur: 0 },
        { id: 'K', dur: 2, parent: 'P' },
      ],
      deps: [['X', 'P']],
    });
    expect(schedule(bad).unsupportedDepIds.has('d1')).toBe(true);
    expect(addDependency(bad, { id: 'dx', predecessorId: 'X', successorId: 'P' }).ok).toBe(false);
  });

  it('nests to arbitrary depth', () => {
    const deep = buildProject({
      tasks: [
        { id: 'L0', dur: 0 },
        { id: 'L1', dur: 0, parent: 'L0' },
        { id: 'leafA', dur: 2, parent: 'L1' },
        { id: 'leafB', dur: 3, parent: 'L1' },
      ],
      deps: [['leafA', 'leafB']],
    });
    expect(span(deep, 'L1')).toEqual([0, 4]);
    expect(span(deep, 'L0')).toEqual([0, 4]);
  });

  it('repairs a parent reference that points at a missing task', () => {
    const orphan = buildProject({ tasks: [{ id: 'A', dur: 2, parent: 'ghost' }] });
    const result = schedule(orphan);
    expect(result.order).toEqual(['A']);
    expect(result.tasks.get('A')!.depth).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// Holidays
// ─────────────────────────────────────────────────────────────────────────────────

describe('holidays', () => {
  it('pushes work past a mid-week holiday without changing its duration', () => {
    const project = buildProject({
      calendar: { ...DEFAULT_CALENDAR, holidays: ['2026-03-04'] },
      tasks: [{ id: 'A', dur: 5 }],
    });
    const a = schedule(project).tasks.get('A')!;
    expect(a.durationDays).toBe(5);
    // Mon, Tue, (holiday Wed), Thu, Fri, Mon
    expect(a.start).toBe(wd(0));
    expect(a.end).toBe(wd(5));
  });
});
