/**
 * Document mutations.
 *
 * Every function here takes a project and returns a new one — no in-place writes — so
 * the app can keep an undo stack by holding on to previous values, and React can rely
 * on reference identity to know what changed.
 *
 * Operations that can be *invalid* return a `MutationResult` rather than throwing or
 * silently doing nothing. Adding a dependency is the important case: a rejected link
 * comes back with the cycle path so the UI can name the tickets involved.
 */

import { DEFAULT_CALENDAR } from './calendar.js';
import type { DayNum, ISODate } from './day.js';
import type { TaskDates } from './duration.js';
import { findDependencyCycle } from './schedule.js';
import {
  DEFAULT_SETTINGS,
  type Baseline,
  type Dependency,
  type DepType,
  type Project,
  type Resource,
  type Task,
} from './types.js';
import { buildWbs } from './wbs.js';

export type MutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; cycle?: string[] };

export interface CreateProjectInput {
  id: string;
  name: string;
  startDate: ISODate;
}

export function createEmptyProject(input: CreateProjectInput): Project {
  return {
    id: input.id,
    name: input.name,
    startDate: input.startDate,
    calendar: DEFAULT_CALENDAR,
    tasks: [],
    dependencies: [],
    resources: [],
    baselines: [],
    activeBaselineId: null,
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** Deterministic id: `prefix-N` for the smallest N not already taken. No randomness. */
export function makeId(prefix: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const id of taken) used.add(id);
  for (let n = 1; ; n++) {
    const candidate = `${prefix}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function newTaskId(project: Project): string {
  return makeId('t', project.tasks.map((t) => t.id));
}

export function newDependencyId(project: Project): string {
  return makeId('d', project.dependencies.map((d) => d.id));
}

export const TASK_DEFAULTS: Omit<Task, 'id' | 'name'> = {
  parentId: null,
  durationDays: 1,
  percentComplete: 0,
  status: 'not-started',
  priority: 'medium',
  assigneeIds: [],
};

export function addTask(
  project: Project,
  task: Partial<Task> & { id: string; name: string },
  options: { afterId?: string } = {},
): Project {
  const full: Task = { ...TASK_DEFAULTS, ...task };
  const tasks = [...project.tasks];
  const at = options.afterId ? tasks.findIndex((t) => t.id === options.afterId) : -1;
  if (at >= 0) tasks.splice(at + 1, 0, full);
  else tasks.push(full);
  return { ...project, tasks };
}

export function updateTask(project: Project, id: string, patch: Partial<Task>): Project {
  let changed = false;
  const tasks = project.tasks.map((task) => {
    if (task.id !== id) return task;
    changed = true;
    return { ...task, ...patch, id: task.id };
  });
  return changed ? { ...project, tasks } : project;
}

/** Removes a task, its whole subtree, and every dependency touching any of them. */
export function removeTask(project: Project, id: string): Project {
  const wbs = buildWbs(project.tasks);
  const doomed = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (doomed.has(current)) continue;
    doomed.add(current);
    for (const child of wbs.childrenOf.get(current) ?? []) stack.push(child);
  }

  return {
    ...project,
    tasks: project.tasks.filter((task) => !doomed.has(task.id)),
    dependencies: project.dependencies.filter(
      (dep) => !doomed.has(dep.predecessorId) && !doomed.has(dep.successorId),
    ),
  };
}

/** Re-parents a task and moves it in the display order. Refuses to nest a task under itself. */
export function moveTask(
  project: Project,
  id: string,
  target: { parentId: string | null; index?: number },
): MutationResult<Project> {
  const task = project.tasks.find((t) => t.id === id);
  if (!task) return { ok: false, reason: `No task ${id}.` };

  if (target.parentId !== null) {
    if (target.parentId === id) {
      return { ok: false, reason: 'A task cannot be its own parent.' };
    }
    const wbs = buildWbs(project.tasks);
    let cursor: string | null = target.parentId;
    while (cursor !== null) {
      if (cursor === id) {
        return { ok: false, reason: 'A task cannot be nested inside its own subtree.' };
      }
      cursor = wbs.parentOf.get(cursor) ?? null;
    }
    if (!project.tasks.some((t) => t.id === target.parentId)) {
      return { ok: false, reason: `No task ${target.parentId}.` };
    }
  }

  const without = project.tasks.filter((t) => t.id !== id);
  const moved: Task = { ...task, parentId: target.parentId };
  const siblingIndexes = without
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.parentId === target.parentId)
    .map(({ i }) => i);

  let insertAt: number;
  if (target.index === undefined || siblingIndexes.length === 0) {
    insertAt = siblingIndexes.length > 0 ? siblingIndexes[siblingIndexes.length - 1]! + 1 : without.length;
  } else {
    const clamped = Math.max(0, Math.min(target.index, siblingIndexes.length));
    insertAt = clamped === siblingIndexes.length ? siblingIndexes[clamped - 1]! + 1 : siblingIndexes[clamped]!;
  }

  const tasks = [...without];
  tasks.splice(insertAt, 0, moved);
  return { ok: true, value: { ...project, tasks } };
}

/** Nest a task under its preceding sibling, the way a WBS outliner indents. */
export function indentTask(project: Project, id: string): MutationResult<Project> {
  const wbs = buildWbs(project.tasks);
  const parentId = wbs.parentOf.get(id) ?? null;
  const siblings = parentId === null ? wbs.roots : (wbs.childrenOf.get(parentId) ?? []);
  const at = siblings.indexOf(id);
  if (at <= 0) return { ok: false, reason: 'Nothing to indent under.' };
  return moveTask(project, id, { parentId: siblings[at - 1]! });
}

/** Promote a task to its grandparent's level. */
export function outdentTask(project: Project, id: string): MutationResult<Project> {
  const wbs = buildWbs(project.tasks);
  const parentId = wbs.parentOf.get(id) ?? null;
  if (parentId === null) return { ok: false, reason: 'Already at the top level.' };
  const grandparentId = wbs.parentOf.get(parentId) ?? null;
  const uncles = grandparentId === null ? wbs.roots : (wbs.childrenOf.get(grandparentId) ?? []);
  return moveTask(project, id, {
    parentId: grandparentId,
    index: uncles.indexOf(parentId) + 1,
  });
}

/**
 * Move a task one slot up or down among its siblings. Order is the array's order.
 *
 * A row never leaves its parent: this is the vertical counterpart to indent/outdent,
 * not a re-parenting op. `moveTask`'s `index` is a sibling index over the list with the
 * task already removed, so `at + delta` is correct in both directions — removing the
 * task shifts its trailing siblings down by one, which is exactly what a downward move
 * wants.
 *
 * A summary task carries its subtree for free: `buildWbs` walks depth-first, so a
 * subtree is always contiguous in `project.tasks`.
 */
export function shiftTask(project: Project, id: string, delta: -1 | 1): MutationResult<Project> {
  const wbs = buildWbs(project.tasks);
  const parentId = wbs.parentOf.get(id) ?? null;
  const siblings = parentId === null ? wbs.roots : (wbs.childrenOf.get(parentId) ?? []);
  const at = siblings.indexOf(id);
  if (at < 0) return { ok: false, reason: `No task ${id}.` };
  const next = at + delta;
  if (next < 0) return { ok: false, reason: 'Already first among its siblings.' };
  if (next >= siblings.length) return { ok: false, reason: 'Already last among its siblings.' };
  return moveTask(project, id, { parentId, index: next });
}

export interface NewDependency {
  id: string;
  predecessorId: string;
  successorId: string;
  type?: DepType;
  lagDays?: number;
}

/**
 * Validates and adds a link. This is the enforcement point CRITERIA asks for: a loop
 * is refused *before* anything is written, and the rejection carries the path.
 */
export function addDependency(
  project: Project,
  candidate: NewDependency,
): MutationResult<Project> {
  const { predecessorId, successorId } = candidate;

  const byId = new Map(project.tasks.map((t) => [t.id, t]));
  if (!byId.has(predecessorId)) return { ok: false, reason: `No task ${predecessorId}.` };
  if (!byId.has(successorId)) return { ok: false, reason: `No task ${successorId}.` };
  if (predecessorId === successorId) {
    return { ok: false, reason: 'A task cannot depend on itself.' };
  }

  const wbs = buildWbs(project.tasks);
  if (wbs.isSummary(successorId)) {
    return {
      ok: false,
      reason:
        'A summary task’s dates are derived from its children, so it cannot be a successor. Link a child instead.',
    };
  }
  if (isRelated(wbs, predecessorId, successorId)) {
    return { ok: false, reason: 'A task cannot depend on its own parent or child.' };
  }
  if (
    project.dependencies.some(
      (dep) => dep.predecessorId === predecessorId && dep.successorId === successorId,
    )
  ) {
    return { ok: false, reason: 'These tasks are already linked.' };
  }

  const cycle = findDependencyCycle(project, { predecessorId, successorId });
  if (cycle) {
    return { ok: false, reason: 'That link would create a circular dependency.', cycle };
  }

  const dependency: Dependency = {
    id: candidate.id,
    predecessorId,
    successorId,
    type: candidate.type ?? 'FS',
    lagDays: candidate.lagDays ?? 0,
  };
  return { ok: true, value: { ...project, dependencies: [...project.dependencies, dependency] } };
}

function isRelated(wbs: ReturnType<typeof buildWbs>, a: string, b: string): boolean {
  const climbs = (from: string, to: string): boolean => {
    let cursor = wbs.parentOf.get(from) ?? null;
    while (cursor !== null) {
      if (cursor === to) return true;
      cursor = wbs.parentOf.get(cursor) ?? null;
    }
    return false;
  };
  return climbs(a, b) || climbs(b, a);
}

/** Changing a type or lag cannot create a cycle, so this never fails. */
export function updateDependency(
  project: Project,
  id: string,
  patch: { type?: DepType; lagDays?: number },
): Project {
  const dependencies = project.dependencies.map((dep) =>
    dep.id === id ? { ...dep, ...patch } : dep,
  );
  return { ...project, dependencies };
}

export function removeDependency(project: Project, id: string): Project {
  return { ...project, dependencies: project.dependencies.filter((dep) => dep.id !== id) };
}

/**
 * Pins a task where the user dropped it.
 *
 * Writes `SNET` at the new start plus the new duration. `SNET` rather than `MSO` on
 * purpose: the task holds its place but still yields to its predecessors, so a drag
 * cannot quietly break a dependency it is subject to.
 */
export function pinTaskDates(project: Project, id: string, dates: TaskDates): Project {
  return updateTask(project, id, {
    durationDays: dates.durationDays,
    constraint: { type: 'SNET', day: dates.start },
  });
}

export function setConstraint(
  project: Project,
  id: string,
  constraint: { type: 'SNET' | 'MSO'; day: DayNum } | null,
): Project {
  const tasks = project.tasks.map((task) => {
    if (task.id !== id) return task;
    if (constraint === null) {
      const { constraint: _dropped, ...rest } = task;
      return rest as Task;
    }
    return { ...task, constraint };
  });
  return { ...project, tasks };
}

export function saveBaseline(project: Project, baseline: Baseline): Project {
  return {
    ...project,
    baselines: [...project.baselines, baseline],
    activeBaselineId: baseline.id,
    settings: { ...project.settings, showBaseline: true },
  };
}

export function removeBaseline(project: Project, id: string): Project {
  const baselines = project.baselines.filter((baseline) => baseline.id !== id);
  return {
    ...project,
    baselines,
    activeBaselineId:
      project.activeBaselineId === id ? (baselines[0]?.id ?? null) : project.activeBaselineId,
  };
}

export function activeBaseline(project: Project): Baseline | null {
  if (!project.activeBaselineId) return null;
  return project.baselines.find((b) => b.id === project.activeBaselineId) ?? null;
}

export function upsertResource(project: Project, resource: Resource): Project {
  const at = project.resources.findIndex((r) => r.id === resource.id);
  const resources = [...project.resources];
  if (at >= 0) resources[at] = resource;
  else resources.push(resource);
  return { ...project, resources };
}
