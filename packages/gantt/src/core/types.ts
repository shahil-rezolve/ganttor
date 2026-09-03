/**
 * The Ganttor document model.
 *
 * The load-bearing decision here: a `Task` has a duration and optional constraints,
 * but **no start or end date**. Dates are outputs of `schedule()`, derived from the
 * dependency graph every time the project changes. Storing them on the task is what
 * lets a Gantt tool drift out of agreement with its own dependency arrows.
 */

import type { WorkCalendar } from './calendar.js';
import type { DayNum, ISODate } from './day.js';

/** The four dependency types from the PMI vocabulary. */
export type DepType =
  /** Finish-to-start: the successor starts after the predecessor finishes. */
  | 'FS'
  /** Start-to-start: the successor starts no earlier than the predecessor starts. */
  | 'SS'
  /** Finish-to-finish: the successor finishes no earlier than the predecessor finishes. */
  | 'FF'
  /** Start-to-finish: the successor finishes no earlier than the predecessor starts. */
  | 'SF';

export const DEP_TYPES: readonly DepType[] = ['FS', 'SS', 'FF', 'SF'];

export const DEP_TYPE_LABELS: Record<DepType, string> = {
  FS: 'Finish → Start',
  SS: 'Start → Start',
  FF: 'Finish → Finish',
  SF: 'Start → Finish',
};

export type TaskStatus = 'not-started' | 'on-track' | 'at-risk' | 'delayed' | 'done';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'not-started',
  'on-track',
  'at-risk',
  'delayed',
  'done',
];

export type Priority = 'highest' | 'high' | 'medium' | 'low' | 'lowest';

export const PRIORITIES: readonly Priority[] = ['highest', 'high', 'medium', 'low', 'lowest'];

/**
 * Scheduling constraints.
 * - `SNET` — start no earlier than. Written when a user drags a bar: the task keeps
 *   obeying its predecessors but will not slide back to the project start.
 * - `MSO` — must start on. A hard pin; a predecessor that would push the task later
 *   raises a conflict instead of moving it.
 */
export type ConstraintType = 'SNET' | 'MSO';

export interface TaskConstraint {
  type: ConstraintType;
  day: DayNum;
}

export interface Task {
  id: string;
  /** Jira issue key, when the task came from an import. */
  jiraKey?: string;
  name: string;
  /** WBS parent. `null` for a top-level task. */
  parentId: string | null;
  /**
   * Length in *working* days, inclusive. `0` makes the task a milestone: a
   * zero-duration marker whose start always equals its end.
   */
  durationDays: number;
  constraint?: TaskConstraint;
  /** 0–100. On a summary task this is derived, not stored. */
  percentComplete: number;
  status: TaskStatus;
  priority: Priority;
  /** Resource ids. */
  assigneeIds: string[];
  /** Free-form grouping used by the `phase` colour mode. */
  phase?: string;
  /** Collapsed in the task grid. Affects display only. */
  collapsed?: boolean;
  notes?: string;
}

export interface Dependency {
  id: string;
  predecessorId: string;
  successorId: string;
  type: DepType;
  /** Working days of delay. Negative values are leads (overlap). */
  lagDays: number;
}

export interface Resource {
  id: string;
  name: string;
  /** Working days per day this resource can absorb. 1 = full time. */
  capacity: number;
  /** Stable colour index for avatars and the workload view. */
  colorIndex?: number;
}

/** A frozen snapshot of the schedule, used for planned-vs-actual comparison. */
export interface Baseline {
  id: string;
  name: string;
  /** ISO timestamp, supplied by the caller so the engine stays pure. */
  savedAt: string;
  bars: Readonly<Record<string, BaselineBar>>;
}

export interface BaselineBar {
  start: DayNum;
  end: DayNum;
  durationDays: number;
  percentComplete: number;
}

export type ColorBy = 'status' | 'priority' | 'assignee' | 'phase';

export interface ProjectSettings {
  colorBy: ColorBy;
  /** Duration applied to an imported issue with no usable dates or estimate. */
  defaultDurationDays: number;
  /** Story-point-to-working-day factor used by the Jira importer. */
  pointsToDays: number;
  showBaseline: boolean;
  showCriticalPath: boolean;
  /**
   * Read-only lock. The single-user stand-in for a view/edit permission level.
   *
   * Defaults to *locked*: the workspace is shared and every signed-in user is a peer
   * with full write access, so a project should not be editable by accident merely
   * because someone opened it. Unlocking is one click, is per document, and persists —
   * which makes editing a thing you opted into rather than the resting state.
   */
  locked: boolean;
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  colorBy: 'status',
  defaultDurationDays: 3,
  pointsToDays: 1,
  showBaseline: false,
  showCriticalPath: true,
  locked: true,
};

export interface Project {
  id: string;
  name: string;
  /** No task may start before this date. */
  startDate: ISODate;
  calendar: WorkCalendar;
  /** Display order within each sibling group is this array's order. */
  tasks: Task[];
  dependencies: Dependency[];
  resources: Resource[];
  baselines: Baseline[];
  activeBaselineId: string | null;
  settings: ProjectSettings;
}

/** What a task turned out to be once the graph was resolved. */
export type TaskKind = 'task' | 'milestone' | 'summary';

export type ScheduleConflict =
  /** An `MSO` pin that predecessors would have pushed later. */
  | 'constraint-violated'
  /** The task sits on a dependency cycle; its incoming cyclic edges were ignored. */
  | 'in-cycle';

export interface ScheduledTask {
  id: string;
  kind: TaskKind;
  /** Early start. */
  start: DayNum;
  /** Early finish, inclusive. */
  end: DayNum;
  /** Working days between start and end, inclusive. 0 for a milestone. */
  durationDays: number;
  lateStart: DayNum;
  lateFinish: DayNum;
  /** Working days of slack. Negative means the schedule cannot be met. */
  totalFloat: number;
  isCritical: boolean;
  /** Derived on summary tasks, passed through otherwise. */
  percentComplete: number;
  /** Dependencies that actually determined this task's dates. */
  bindingDepIds: string[];
  conflicts: ScheduleConflict[];
  /** Nesting level; 0 for top-level tasks. */
  depth: number;
}

export interface ScheduleResult {
  tasks: ReadonlyMap<string, ScheduledTask>;
  /** Dependencies on the critical path. */
  criticalLinkIds: ReadonlySet<string>;
  /** Dependencies excluded from scheduling because they close a cycle. */
  cyclicDepIds: ReadonlySet<string>;
  /** Each cycle as a path of task ids, first id repeated last: `[a, b, c, a]`. */
  cycles: string[][];
  /** Dependencies ignored because their successor is a summary task. */
  unsupportedDepIds: ReadonlySet<string>;
  projectStart: DayNum;
  projectFinish: DayNum;
  /** Display order: depth-first over the WBS, respecting sibling array order. */
  order: string[];
}
