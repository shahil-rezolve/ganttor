/**
 * The CRITERIA verification suite, part two: critical path accuracy.
 *
 * *"Compare app-highlighted path to manual CPM calculation on sample data."* Two kinds
 * of check do that here, and they are complementary.
 *
 * 1. **Exact.** A small project whose ES/EF/LS/LF/float were computed by hand, with
 *    every number asserted. This catches sign errors and off-by-one weekend snapping.
 *
 * 2. **Behavioural.** Total float has a definition independent of how it is computed:
 *    *the amount a task can slip without moving the project finish.* So for every task
 *    in the 25-task demo, slipping it by exactly its float must leave the finish alone,
 *    and slipping it by one more day must push the finish by exactly one day. That
 *    exercises the backward pass against the forward pass — two different algorithms
 *    agreeing — rather than against numbers typed by the same person who wrote it.
 */

import { describe, expect, it } from 'vitest';

import { compileCalendar, DEFAULT_CALENDAR } from './calendar.js';
import { updateTask } from './project.js';
import { schedule } from './schedule.js';
import type { Project } from './types.js';
import { createDemoProject } from '../fixtures/demo.js';
import { buildProject, KIT_START, workingDayIndexer } from '../fixtures/kit.js';

const wd = workingDayIndexer(KIT_START);
const cal = compileCalendar(DEFAULT_CALENDAR);
const idx = (day: number): number => cal.workingDayDelta(wd(0), day);

describe('critical path — exact, hand-computed', () => {
  /**
   *      ┌──────── A (5d) ────────┐
   *      │ FS                     │ SS +1
   *      ▼                        ▼
   *      B (3d)                   C (4d)
   *      │ FS                     │ FS
   *      └────────► D (2d) ◄───────┘
   *                 │ FS
   *                 ▼
   *                 M (milestone)
   *
   * By hand, in working days from the project start:
   *
   * | Task | ES | EF | LS | LF | Float | Critical |
   * |------|----|----|----|----|-------|----------|
   * | A    |  0 |  4 |  0 |  4 |     0 | yes      |
   * | B    |  5 |  7 |  5 |  7 |     0 | yes      |
   * | C    |  1 |  4 |  4 |  7 |     3 | no       |
   * | D    |  8 |  9 |  8 |  9 |     0 | yes      |
   * | M    | 10 | 10 | 10 | 10 |     0 | yes      |
   */
  const project = buildProject({
    tasks: [
      { id: 'A', dur: 5 },
      { id: 'B', dur: 3 },
      { id: 'C', dur: 4 },
      { id: 'D', dur: 2 },
      { id: 'M', dur: 0 },
    ],
    deps: [
      ['A', 'B', 'FS', 0],
      ['A', 'C', 'SS', 1],
      ['B', 'D', 'FS', 0],
      ['C', 'D', 'FS', 0],
      ['D', 'M', 'FS', 0],
    ],
  });

  const result = schedule(project);

  const expected = {
    A: { es: 0, ef: 4, ls: 0, lf: 4, float: 0, critical: true },
    B: { es: 5, ef: 7, ls: 5, lf: 7, float: 0, critical: true },
    C: { es: 1, ef: 4, ls: 4, lf: 7, float: 3, critical: false },
    D: { es: 8, ef: 9, ls: 8, lf: 9, float: 0, critical: true },
    M: { es: 10, ef: 10, ls: 10, lf: 10, float: 0, critical: true },
  } as const;

  for (const [id, want] of Object.entries(expected)) {
    it(`${id} matches the manual calculation`, () => {
      const task = result.tasks.get(id)!;
      expect({
        es: idx(task.start),
        ef: idx(task.end),
        ls: idx(task.lateStart),
        lf: idx(task.lateFinish),
        float: task.totalFloat,
        critical: task.isCritical,
      }).toEqual(want);
    });
  }

  it('finishes when the last critical task finishes', () => {
    expect(idx(result.projectFinish)).toBe(10);
    expect(idx(result.projectStart)).toBe(0);
  });

  it('highlights the chain, not every zero-float task pair', () => {
    // d1 = A→B, d2 = A→C, d3 = B→D, d4 = C→D, d5 = D→M
    expect([...result.criticalLinkIds].sort()).toEqual(['d1', 'd3', 'd5']);
    // A and C are both on the graph but C has float, so A→C is not critical.
    expect(result.criticalLinkIds.has('d2')).toBe(false);
    // C→D connects a non-critical task and is not what set D's date.
    expect(result.criticalLinkIds.has('d4')).toBe(false);
  });
});

describe('critical path — finish-to-finish and start-to-finish', () => {
  /**
   * T is pinned late, which is what makes the FF and SF links bind at all. Without a
   * pinned predecessor both types are usually dominated by the project start, so a
   * suite that only tests them in the easy case never exercises the arithmetic.
   */
  const project = buildProject({
    tasks: [
      { id: 'T', dur: 3, snet: 5 },
      { id: 'S', dur: 2 },
      { id: 'U', dur: 2 },
      { id: 'V', dur: 4 },
    ],
    deps: [
      ['T', 'S', 'SF', 0],
      ['T', 'U', 'FF', 2],
      ['T', 'V', 'FF', 0],
    ],
  });

  const result = schedule(project);

  it('start-to-finish pulls the successor finish up to the predecessor start', () => {
    // T starts on day 5, so S must finish by then; being 2 days long it starts on day 4.
    expect(idx(result.tasks.get('T')!.start)).toBe(5);
    expect(idx(result.tasks.get('S')!.start)).toBe(4);
    expect(idx(result.tasks.get('S')!.end)).toBe(5);
  });

  it('finish-to-finish with lag pushes the successor finish past the predecessor', () => {
    // T ends day 7; U must end no earlier than day 9, so a 2-day task starts day 8.
    expect(idx(result.tasks.get('T')!.end)).toBe(7);
    expect(idx(result.tasks.get('U')!.start)).toBe(8);
    expect(idx(result.tasks.get('U')!.end)).toBe(9);
  });

  it('finish-to-finish with no lag aligns the finishes exactly', () => {
    expect(idx(result.tasks.get('V')!.end)).toBe(7);
    expect(idx(result.tasks.get('V')!.start)).toBe(4);
  });

  it('puts the project finish on the finish-to-finish successor with lag', () => {
    expect(idx(result.projectFinish)).toBe(9);
    expect(result.tasks.get('U')!.isCritical).toBe(true);
    expect(result.criticalLinkIds.has('d2')).toBe(true);
  });
});

describe('critical path — float means what it says', () => {
  const demo = createDemoProject();
  const demoCal = compileCalendar(demo.calendar);
  const baseline = schedule(demo);

  /** Push a task's earliest start later by `days` working days. */
  const slip = (project: Project, id: string, from: number, days: number): Project =>
    updateTask(project, id, {
      constraint: { type: 'SNET', day: demoCal.ceilShift(from, days) },
    });

  const leaves = [...baseline.tasks.values()].filter((task) => task.kind !== 'summary');

  it('has a non-trivial project with both critical and slack tasks', () => {
    expect(leaves.length).toBeGreaterThanOrEqual(20);
    expect(leaves.some((t) => t.isCritical)).toBe(true);
    expect(leaves.some((t) => !t.isCritical)).toBe(true);
    expect(baseline.cyclicDepIds.size).toBe(0);
    expect(baseline.unsupportedDepIds.size).toBe(0);
  });

  for (const task of leaves) {
    it(`${task.id} can absorb exactly its ${task.totalFloat} day(s) of float`, () => {
      const atFloat = schedule(slip(demo, task.id, task.start, task.totalFloat));
      expect(demoCal.workingDayDelta(baseline.projectFinish, atFloat.projectFinish)).toBe(0);

      const pastFloat = schedule(slip(demo, task.id, task.start, task.totalFloat + 1));
      expect(demoCal.workingDayDelta(baseline.projectFinish, pastFloat.projectFinish)).toBe(1);
    });
  }

  it('finishes on a task with no float', () => {
    const finishers = leaves.filter((t) => t.end === baseline.projectFinish);
    expect(finishers.length).toBeGreaterThan(0);
    for (const task of finishers) expect(task.isCritical).toBe(true);
  });

  it('connects every critical task forward to the project finish', () => {
    const criticalLinks = demo.dependencies.filter((dep) => baseline.criticalLinkIds.has(dep.id));
    const successorsOf = new Map<string, string[]>();
    for (const dep of criticalLinks) {
      let list = successorsOf.get(dep.predecessorId);
      if (!list) successorsOf.set(dep.predecessorId, (list = []));
      list.push(dep.successorId);
    }

    const criticalIds = leaves.filter((t) => t.isCritical).map((t) => t.id);
    for (const id of criticalIds) {
      let cursor = id;
      const seen = new Set<string>([cursor]);
      while (baseline.tasks.get(cursor)!.end !== baseline.projectFinish) {
        const next = (successorsOf.get(cursor) ?? []).find((s) => !seen.has(s));
        expect(next, `critical task ${cursor} has no critical link forward`).toBeDefined();
        cursor = next!;
        seen.add(cursor);
      }
    }
  });
});

describe('critical path — a summary task is a container, not critical work', () => {
  const project = buildProject({
    tasks: [
      { id: 'P', dur: 0 },
      { id: 'K', dur: 4, parent: 'P' },
    ],
  });
  const result = schedule(project);

  it('leaves the summary uncritical while its child is critical', () => {
    expect(result.tasks.get('K')!.isCritical).toBe(true);
    expect(result.tasks.get('P')!.isCritical).toBe(false);
  });

  it('rolls the child late dates up onto the summary', () => {
    const summary = result.tasks.get('P')!;
    const child = result.tasks.get('K')!;
    expect(summary.lateStart).toBe(child.lateStart);
    expect(summary.lateFinish).toBe(child.lateFinish);
    expect(summary.totalFloat).toBe(child.totalFloat);
  });
});
