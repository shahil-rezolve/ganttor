/**
 * Critical path method — the backward pass.
 *
 * This is textbook CPM, not the "longest chain of bars" approximation. The forward
 * pass in `schedule.ts` produces early start and early finish. Here we walk the
 * topological order in reverse to derive late start and late finish, then define
 * total float as the working-day gap between early and late start. A task with zero
 * float cannot slip without moving the project finish, which is what *critical*
 * actually means.
 *
 * Each dependency type inverts differently. Working forwards, a constraint says the
 * successor may not start (or finish) before some day. Working backwards, the same
 * constraint says the predecessor may not finish (or start) after some day:
 *
 * | Type | Forward                        | Backward                          |
 * |------|--------------------------------|-----------------------------------|
 * | FS   | `s.start ≥ p.end + 1 + lag`    | `p.lateFinish ≤ s.lateStart − 1 − lag` |
 * | SS   | `s.start ≥ p.start + lag`      | `p.lateStart  ≤ s.lateStart − lag`     |
 * | FF   | `s.end   ≥ p.end + lag`        | `p.lateFinish ≤ s.lateFinish − lag`    |
 * | SF   | `s.end   ≥ p.start + lag`      | `p.lateStart  ≤ s.lateFinish − lag`    |
 *
 * Bounds on late start are converted into bounds on late finish through the task's
 * duration, and the tightest bound wins. Because these are *upper* bounds, a bound
 * landing on a weekend snaps backward (`floorShift`), never forward.
 */

import type { CompiledCalendar } from './calendar.js';
import type { DayNum } from './day.js';
import type { Dependency, ScheduledTask } from './types.js';
import type { Wbs } from './wbs.js';

/** A `ScheduledTask` while the engine is still filling it in. */
export type DraftTask = {
  -readonly [K in keyof ScheduledTask]: ScheduledTask[K];
};

export interface BackwardPassInput {
  calendar: CompiledCalendar;
  wbs: Wbs;
  /** Topological order of the *leaf* tasks, from the forward pass. */
  topoOrder: readonly string[];
  drafts: Map<string, DraftTask>;
  /**
   * Dependencies that took part in scheduling, already expanded onto leaf tasks so
   * that a summary predecessor appears as one link per leaf descendant.
   *
   * Expansion is exact for FS and FF, whose constraints read against a summary's
   * *latest* child finish and therefore bind every child. It is conservative for SS
   * and SF from a summary predecessor, which read against the *earliest* child start
   * — a disjunction CPM cannot express — so those leaves may report slightly less
   * float than they truly have.
   */
  activeDeps: readonly Dependency[];
  projectFinish: DayNum;
}

export interface BackwardPassResult {
  criticalLinkIds: Set<string>;
}

export function runBackwardPass(input: BackwardPassInput): BackwardPassResult {
  const { calendar, wbs, topoOrder, drafts, activeDeps, projectFinish } = input;

  const outgoing = new Map<string, Dependency[]>();
  for (const dep of activeDeps) {
    let list = outgoing.get(dep.predecessorId);
    if (!list) outgoing.set(dep.predecessorId, (list = []));
    list.push(dep);
  }

  // Leaves first, in reverse topological order, so every successor is already final.
  for (let i = topoOrder.length - 1; i >= 0; i--) {
    const id = topoOrder[i]!;
    const draft = drafts.get(id);
    if (!draft || draft.kind === 'summary') continue;

    // A task with no successors may finish as late as the project does.
    let lateFinish = projectFinish;

    for (const dep of outgoing.get(id) ?? []) {
      const successor = drafts.get(dep.successorId);
      if (!successor || successor.kind === 'summary') continue;

      const lag = dep.lagDays;
      let bound: DayNum;

      switch (dep.type) {
        case 'FS':
          bound = calendar.floorShift(successor.lateStart, -(1 + lag));
          break;
        case 'FF':
          bound = calendar.floorShift(successor.lateFinish, -lag);
          break;
        case 'SS': {
          const lateStartBound = calendar.floorShift(successor.lateStart, -lag);
          bound = calendar.endFromStart(lateStartBound, draft.durationDays);
          break;
        }
        case 'SF': {
          const lateStartBound = calendar.floorShift(successor.lateFinish, -lag);
          bound = calendar.endFromStart(lateStartBound, draft.durationDays);
          break;
        }
      }

      if (bound < lateFinish) lateFinish = bound;
    }

    draft.lateFinish = calendar.snapBack(lateFinish);
    draft.lateStart = calendar.startFromEnd(draft.lateFinish, draft.durationDays);
    draft.totalFloat = calendar.workingDayDelta(draft.start, draft.lateStart);
    draft.isCritical = draft.totalFloat <= 0;
  }

  // Summary tasks are rollups, so their late dates and float roll up too. `wbs.order`
  // is depth-first, so walking it backwards guarantees children before parents —
  // including nested summaries.
  for (let i = wbs.order.length - 1; i >= 0; i--) {
    const id = wbs.order[i]!;
    const draft = drafts.get(id);
    if (!draft || draft.kind !== 'summary') continue;

    let lateStart = Number.POSITIVE_INFINITY;
    let lateFinish = Number.NEGATIVE_INFINITY;
    let minFloat = Number.POSITIVE_INFINITY;

    for (const childId of wbs.childrenOf.get(id) ?? []) {
      const child = drafts.get(childId);
      if (!child) continue;
      if (child.lateStart < lateStart) lateStart = child.lateStart;
      if (child.lateFinish > lateFinish) lateFinish = child.lateFinish;
      if (child.totalFloat < minFloat) minFloat = child.totalFloat;
    }

    if (Number.isFinite(lateStart)) {
      draft.lateStart = lateStart;
      draft.lateFinish = lateFinish;
      draft.totalFloat = minFloat;
    }
    // A summary is a container, never critical work in its own right.
    draft.isCritical = false;
  }

  // A link is on the critical path when both ends are critical *and* it is what
  // actually determined the successor's dates. Without the binding check, any two
  // zero-float tasks would appear connected by a critical arrow.
  const criticalLinkIds = new Set<string>();
  for (const dep of activeDeps) {
    const predecessor = drafts.get(dep.predecessorId);
    const successor = drafts.get(dep.successorId);
    if (!predecessor?.isCritical || !successor?.isCritical) continue;
    if (successor.bindingDepIds.includes(dep.id)) criticalLinkIds.add(dep.id);
  }

  return { criticalLinkIds };
}
