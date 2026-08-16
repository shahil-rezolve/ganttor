/**
 * The forward pass: turn a project document into dated bars.
 *
 * `schedule()` is the whole engine's entry point and it is pure — same project in,
 * same result out, no clock, no I/O. Every visual claim the UI makes reduces to an
 * assertion about the object it returns.
 *
 * ## How dependencies constrain a task
 *
 * For a dependency from predecessor *p* to successor *s* with `lag` working days:
 *
 * | Type | Constraint                         |
 * |------|------------------------------------|
 * | FS   | `s.start ≥ p.end   + 1 + lag`      |
 * | SS   | `s.start ≥ p.start + lag`          |
 * | FF   | `s.end   ≥ p.end   + lag`          |
 * | SF   | `s.end   ≥ p.start + lag`          |
 *
 * FF and SF bound the *finish*, so they are converted into an implied start through
 * the task's duration. The task then starts on the latest of: the project start, its
 * own `SNET` constraint, and every implied start. These are lower bounds, so a bound
 * landing on a weekend snaps forward.
 *
 * ## Why dragging a bar writes a constraint
 *
 * A task with no predecessors has nothing holding it in place, so a naive scheduler
 * slides it back to the project start on the next recalculation — the bar springs
 * back the moment you let go. Dragging therefore records `SNET` at the drop date:
 * the task still obeys its predecessors, but it will not drift earlier than where
 * the user put it.
 *
 * ## Summary tasks
 *
 * A task with children is a rollup, not a schedulable entity: its span is its
 * children's span and its progress is their duration-weighted mean. It may act as a
 * *predecessor* — the constraint then reads against its rolled-up dates — but not as
 * a successor, because constraining a derived value is ill-defined. Such links are
 * reported in `unsupportedDepIds` rather than silently half-applied.
 *
 * To keep cycle detection honest, dependencies are expanded onto leaf tasks before
 * the graph is analysed. That leaves a graph of leaves only, so a cycle can never be
 * mistaken for a parent/child rollup edge.
 */

import { compileCalendar, type CompiledCalendar } from './calendar.js';
import { runBackwardPass, type DraftTask } from './cpm.js';
import { toDayNum, type DayNum } from './day.js';
import { analyzeGraph, findPath, type GraphEdge } from './graph.js';
import type { Dependency, Project, ScheduleResult, ScheduledTask, Task } from './types.js';
import { buildWbs, type Wbs } from './wbs.js';

export function schedule(project: Project): ScheduleResult {
  const calendar = compileCalendar(project.calendar);
  const wbs = buildWbs(project.tasks);
  const byId = new Map<string, Task>();
  for (const task of project.tasks) byId.set(task.id, task);

  const projectStartDay = calendar.snapForward(toDayNum(project.startDate));

  const { candidateDeps, unsupportedDepIds } = partitionDependencies(
    project.dependencies,
    byId,
    wbs,
  );

  // Expand onto leaves: a link whose predecessor is a summary becomes one link per
  // leaf descendant. The resulting graph contains only leaf tasks.
  const expanded: { dep: Dependency; from: string; to: string }[] = [];
  for (const dep of candidateDeps) {
    for (const leaf of wbs.leafDescendants(dep.predecessorId)) {
      expanded.push({ dep, from: leaf, to: dep.successorId });
    }
  }

  const leafIds = wbs.order.filter((id) => !wbs.isSummary(id));
  const edges: GraphEdge[] = expanded.map((e) => ({ id: e.dep.id, from: e.from, to: e.to }));
  const analysis = analyzeGraph(leafIds, edges);

  const cyclicDepIds = new Set(analysis.backEdgeIds);
  const activeDeps = candidateDeps.filter((dep) => !cyclicDepIds.has(dep.id));
  const activeExpanded = expanded.filter((e) => !cyclicDepIds.has(e.dep.id));

  const incoming = new Map<string, Dependency[]>();
  for (const dep of activeDeps) {
    let list = incoming.get(dep.successorId);
    if (!list) incoming.set(dep.successorId, (list = []));
    list.push(dep);
  }

  const drafts = new Map<string, DraftTask>();
  const resolve = makePredecessorResolver(drafts, wbs);

  // Flag every task *on* a reported loop, not merely the endpoints of the edge that
  // closed it, so the UI can highlight the whole cycle the user has to break.
  const inCycle = new Set<string>();
  for (const cycle of analysis.cycles) {
    for (const id of cycle) inCycle.add(id);
  }

  for (const id of analysis.order) {
    const task = byId.get(id);
    if (!task) continue;
    drafts.set(
      id,
      scheduleLeaf({
        task,
        calendar,
        projectStartDay,
        depth: wbs.depthOf.get(id) ?? 0,
        predecessors: incoming.get(id) ?? [],
        resolve,
        inCycle: inCycle.has(id),
      }),
    );
  }

  rollUpSummaries({ drafts, wbs, calendar, byId, projectStartDay, inCycle });

  let projectFinish = projectStartDay;
  let projectStart = Number.POSITIVE_INFINITY;
  for (const draft of drafts.values()) {
    if (draft.kind === 'summary') continue;
    if (draft.end > projectFinish) projectFinish = draft.end;
    if (draft.start < projectStart) projectStart = draft.start;
  }
  if (!Number.isFinite(projectStart)) projectStart = projectStartDay;

  const { criticalLinkIds } = runBackwardPass({
    calendar,
    wbs,
    topoOrder: analysis.order,
    drafts,
    activeDeps: activeExpanded.map((e) => ({
      ...e.dep,
      predecessorId: e.from,
      successorId: e.to,
    })),
    projectFinish,
  });

  return {
    tasks: drafts as ReadonlyMap<string, ScheduledTask>,
    criticalLinkIds,
    cyclicDepIds,
    cycles: dedupeCycles(analysis.cycles),
    unsupportedDepIds,
    projectStart,
    projectFinish,
    order: wbs.order,
  };
}

function partitionDependencies(
  dependencies: readonly Dependency[],
  byId: ReadonlyMap<string, Task>,
  wbs: Wbs,
): { candidateDeps: Dependency[]; unsupportedDepIds: Set<string> } {
  const unsupportedDepIds = new Set<string>();
  const candidateDeps: Dependency[] = [];

  for (const dep of dependencies) {
    if (!byId.has(dep.predecessorId) || !byId.has(dep.successorId)) {
      // Dangling link, usually the residue of a deleted task. Nothing to report.
      continue;
    }
    if (
      dep.predecessorId === dep.successorId ||
      wbs.isSummary(dep.successorId) ||
      isAncestor(wbs, dep.predecessorId, dep.successorId) ||
      isAncestor(wbs, dep.successorId, dep.predecessorId)
    ) {
      unsupportedDepIds.add(dep.id);
      continue;
    }
    candidateDeps.push(dep);
  }

  return { candidateDeps, unsupportedDepIds };
}

function isAncestor(wbs: Wbs, ancestorId: string, descendantId: string): boolean {
  let cursor = wbs.parentOf.get(descendantId) ?? null;
  while (cursor !== null) {
    if (cursor === ancestorId) return true;
    cursor = wbs.parentOf.get(cursor) ?? null;
  }
  return false;
}

/** Early dates of a predecessor, rolling a summary up from its leaves on demand. */
type PredecessorResolver = (id: string) => { start: DayNum; end: DayNum } | null;

function makePredecessorResolver(
  drafts: ReadonlyMap<string, DraftTask>,
  wbs: Wbs,
): PredecessorResolver {
  const memo = new Map<string, { start: DayNum; end: DayNum }>();

  return (id) => {
    const direct = drafts.get(id);
    if (direct) return { start: direct.start, end: direct.end };

    const cached = memo.get(id);
    if (cached) return cached;

    // Every leaf of a summary predecessor is scheduled before any of its successors,
    // so the rollup is final the first time it is asked for.
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const leafId of wbs.leafDescendants(id)) {
      const leaf = drafts.get(leafId);
      if (!leaf) continue;
      if (leaf.start < start) start = leaf.start;
      if (leaf.end > end) end = leaf.end;
    }
    if (!Number.isFinite(start)) return null;

    const rolled = { start, end };
    memo.set(id, rolled);
    return rolled;
  };
}

interface ScheduleLeafInput {
  task: Task;
  calendar: CompiledCalendar;
  projectStartDay: DayNum;
  depth: number;
  predecessors: readonly Dependency[];
  resolve: PredecessorResolver;
  inCycle: boolean;
}

function scheduleLeaf(input: ScheduleLeafInput): DraftTask {
  const { task, calendar, projectStartDay, depth, predecessors, resolve, inCycle } = input;

  const duration = Math.max(0, Math.floor(task.durationDays));
  const isMilestone = duration === 0;

  // Every bound is expressed as an implied start so a single max() decides the date.
  let earliestStart = projectStartDay;
  const bindingDepIds: string[] = [];

  if (task.constraint?.type === 'SNET') {
    const pinned = calendar.snapForward(task.constraint.day);
    if (pinned > earliestStart) earliestStart = pinned;
  }

  const impliedStarts: { depId: string; start: DayNum }[] = [];
  for (const dep of predecessors) {
    const predecessor = resolve(dep.predecessorId);
    if (!predecessor) continue;

    let impliedStart: DayNum;
    switch (dep.type) {
      case 'FS':
        impliedStart = calendar.ceilShift(predecessor.end, 1 + dep.lagDays);
        break;
      case 'SS':
        impliedStart = calendar.ceilShift(predecessor.start, dep.lagDays);
        break;
      case 'FF':
        impliedStart = calendar.startFromEnd(
          calendar.ceilShift(predecessor.end, dep.lagDays),
          duration,
        );
        break;
      case 'SF':
        impliedStart = calendar.startFromEnd(
          calendar.ceilShift(predecessor.start, dep.lagDays),
          duration,
        );
        break;
    }

    impliedStarts.push({ depId: dep.id, start: impliedStart });
    if (impliedStart > earliestStart) earliestStart = impliedStart;
  }

  const conflicts: DraftTask['conflicts'] = [];
  let start = earliestStart;

  if (task.constraint?.type === 'MSO') {
    const pinned = calendar.snapForward(task.constraint.day);
    if (earliestStart > pinned) conflicts.push('constraint-violated');
    start = pinned;
  }

  for (const implied of impliedStarts) {
    if (implied.start === start) bindingDepIds.push(implied.depId);
  }

  if (inCycle) conflicts.push('in-cycle');

  const end = calendar.endFromStart(start, duration);

  return {
    id: task.id,
    kind: isMilestone ? 'milestone' : 'task',
    start,
    end,
    durationDays: isMilestone ? 0 : calendar.workingDaysBetween(start, end),
    lateStart: start,
    lateFinish: end,
    totalFloat: 0,
    isCritical: false,
    percentComplete: clampPercent(task.percentComplete),
    bindingDepIds,
    conflicts,
    depth,
  };
}

interface RollUpInput {
  drafts: Map<string, DraftTask>;
  wbs: Wbs;
  calendar: CompiledCalendar;
  byId: ReadonlyMap<string, Task>;
  projectStartDay: DayNum;
  inCycle: ReadonlySet<string>;
}

function rollUpSummaries(input: RollUpInput): void {
  const { drafts, wbs, calendar, byId, projectStartDay, inCycle } = input;

  // `wbs.order` is depth-first, so walking it backwards visits children first.
  for (let i = wbs.order.length - 1; i >= 0; i--) {
    const id = wbs.order[i]!;
    if (!wbs.isSummary(id)) continue;
    const task = byId.get(id);
    if (!task) continue;

    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    let weighted = 0;
    let weight = 0;
    let simpleSum = 0;
    let childCount = 0;

    for (const childId of wbs.childrenOf.get(id) ?? []) {
      const child = drafts.get(childId);
      if (!child) continue;
      if (child.start < start) start = child.start;
      if (child.end > end) end = child.end;
      const childWeight = Math.max(child.durationDays, 0);
      weighted += childWeight * child.percentComplete;
      weight += childWeight;
      simpleSum += child.percentComplete;
      childCount++;
    }

    const hasChildren = Number.isFinite(start);
    const resolvedStart = hasChildren ? start : projectStartDay;
    const resolvedEnd = hasChildren ? end : projectStartDay;

    drafts.set(id, {
      id,
      kind: 'summary',
      start: resolvedStart,
      end: resolvedEnd,
      durationDays: calendar.workingDaysBetween(resolvedStart, resolvedEnd),
      lateStart: resolvedStart,
      lateFinish: resolvedEnd,
      totalFloat: 0,
      isCritical: false,
      // Milestone-only groups have no duration to weight by, so fall back to a plain mean.
      percentComplete: clampPercent(
        weight > 0 ? weighted / weight : childCount > 0 ? simpleSum / childCount : 0,
      ),
      bindingDepIds: [],
      conflicts: inCycle.has(id) ? ['in-cycle'] : [],
      depth: wbs.depthOf.get(id) ?? 0,
    });
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** The same loop can surface once per closing edge; collapse rotations of one cycle. */
function dedupeCycles(cycles: readonly string[][]): string[][] {
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const cycle of cycles) {
    const nodes = cycle.slice(0, -1);
    const key = [...nodes].sort().join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push([...cycle]);
  }
  return result;
}

/**
 * Would adding this link create a loop? Returns the offending path
 * (`[predecessor, successor, …, predecessor]`) or `null` if the link is safe.
 *
 * Call this *before* mutating the project. Reporting the path is the point — a
 * message naming the four tickets involved is actionable; "circular dependency" is not.
 */
export function findDependencyCycle(
  project: Project,
  candidate: { predecessorId: string; successorId: string },
): string[] | null {
  const { predecessorId, successorId } = candidate;
  if (predecessorId === successorId) return [predecessorId, predecessorId];

  const wbs = buildWbs(project.tasks);
  const edges: GraphEdge[] = [];
  for (const dep of project.dependencies) {
    for (const leaf of wbs.leafDescendants(dep.predecessorId)) {
      edges.push({ id: dep.id, from: leaf, to: dep.successorId });
    }
  }

  // The new link closes a loop exactly when the successor already reaches back to
  // the predecessor — or to any leaf beneath it, if the predecessor is a summary.
  for (const target of wbs.leafDescendants(predecessorId)) {
    const path = findPath(edges, successorId, target);
    if (!path) continue;
    // Close the loop for display. When the predecessor is a summary the path ends on
    // one of its leaves, so the summary itself is repeated to show the wrap-around.
    return path[path.length - 1] === predecessorId
      ? [predecessorId, ...path]
      : [predecessorId, ...path, predecessorId];
  }
  return null;
}
