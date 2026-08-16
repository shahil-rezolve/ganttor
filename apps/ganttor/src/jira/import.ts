/**
 * Turning Jira CSV rows into a Ganttor project.
 *
 * The design commitment: **every derived value is reported, never silently invented.**
 * Jira has no duration field, no dependency types, and no lag, so an importer has to
 * infer. Each inference is recorded in `notes` so the wizard's preview can show the user
 * exactly what was assumed before they accept it — the difference between a tool they
 * can trust and one that quietly makes up a schedule.
 *
 * Mapping decisions:
 *
 * - **Duration** in priority order: both dates → working days between them; original
 *   estimate → seconds ÷ a working day; story points → × the points factor; due date
 *   only → the default duration ending on the due date; otherwise the default.
 * - **Dependencies** come from `blocks` / `is blocked by` as finish-to-start with zero
 *   lag, which is the only reading Jira's link model supports. Type and lag are then
 *   edited in Ganttor.
 * - **Hierarchy** from `parent` first, then `epicLink`. An epic with children becomes a
 *   summary row automatically, since that is what having children means.
 * - **Milestones** are issues whose type says so, or which have a due date and a zero
 *   estimate — the conventional way teams mark a date-only checkpoint in Jira.
 */

import {
  compileCalendar,
  DEFAULT_CALENDAR,
  DEFAULT_SETTINGS,
  toISO,
  type Dependency,
  type Priority,
  type Project,
  type Resource,
  type Task,
  type TaskStatus,
  type WorkCalendar,
} from '@ganttor/gantt/core';

import { valueOf, valuesOf, type ColumnMapping } from './columns.js';
import { parseJiraDate } from './dates.js';

export interface ImportOptions {
  /** Working days per story point. */
  pointsToDays: number;
  /** Duration for an issue with nothing to infer from. */
  defaultDurationDays: number;
  /** Reading of ambiguous `nn/nn/nnnn` dates. */
  dayFirst: boolean;
  calendar?: WorkCalendar;
  projectName?: string;
  /** Keep the imported start dates as SNET constraints. */
  pinImportedStarts: boolean;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  pointsToDays: 1,
  defaultDurationDays: 3,
  dayFirst: true,
  pinImportedStarts: true,
};

/** How a task's duration was arrived at, for the preview table. */
export type DurationSource =
  | 'both-dates'
  | 'original-estimate'
  | 'story-points'
  | 'due-date-only'
  | 'default'
  | 'milestone';

export interface ImportedTaskNote {
  taskId: string;
  jiraKey: string;
  durationSource: DurationSource;
  durationDays: number;
  /** True when the row's start date was used to pin the task. */
  pinned: boolean;
}

export interface ImportWarning {
  kind:
    | 'unparsed-date'
    | 'unknown-link-target'
    | 'summary-successor-expanded'
    | 'missing-key'
    | 'duplicate-key'
    | 'unknown-parent'
    | 'end-before-start';
  message: string;
  jiraKey?: string;
}

export interface ImportResult {
  project: Project;
  notes: ImportedTaskNote[];
  warnings: ImportWarning[];
  stats: {
    rows: number;
    tasks: number;
    milestones: number;
    summaries: number;
    dependencies: number;
    resources: number;
  };
}

const SECONDS_PER_WORKING_DAY = 8 * 3600;

const STATUS_BY_CATEGORY: Array<[RegExp, TaskStatus]> = [
  [/^(done|closed|resolved|complete|shipped|released)$/i, 'done'],
  [/^(blocked|impediment|on hold|paused)$/i, 'delayed'],
  [/^(at risk|needs attention|review|in review|qa)$/i, 'at-risk'],
  [/^(in progress|in development|doing|started|active)$/i, 'on-track'],
  [/^(to do|todo|open|backlog|new|selected for development)$/i, 'not-started'],
];

const PRIORITY_BY_NAME: Array<[RegExp, Priority]> = [
  [/^(highest|blocker|p0|critical)$/i, 'highest'],
  [/^(high|major|p1)$/i, 'high'],
  [/^(medium|normal|p2)$/i, 'medium'],
  [/^(low|minor|p3)$/i, 'low'],
  [/^(lowest|trivial|p4)$/i, 'lowest'],
];

const MILESTONE_TYPES = /^(milestone|checkpoint|gate|release|deadline)$/i;

/**
 * Note there is no `SUMMARY_TYPES` counterpart. A task is a summary because it *has
 * children*, not because Jira calls it an epic — an epic with no imported children is
 * an ordinary schedulable task, and treating it as a container would give it no dates.
 */
export function importJiraRows(
  rows: readonly string[][],
  mapping: ColumnMapping,
  options: ImportOptions = DEFAULT_IMPORT_OPTIONS,
): ImportResult {
  const calendarSource = options.calendar ?? DEFAULT_CALENDAR;
  const calendar = compileCalendar(calendarSource);

  const warnings: ImportWarning[] = [];
  const notes: ImportedTaskNote[] = [];

  // ── Pass one: rows to tasks ────────────────────────────────────────────────────
  interface Draft {
    task: Task;
    parentKey: string | null;
    blocks: string[];
    blockedBy: string[];
  }

  const drafts: Draft[] = [];
  const byKey = new Map<string, Draft>();
  const resourceIds = new Map<string, Resource>();
  let earliestStart: number | null = null;

  for (const row of rows) {
    const key = valueOf(row, mapping, 'key');
    if (!key) {
      warnings.push({ kind: 'missing-key', message: 'Skipped a row with no issue key.' });
      continue;
    }
    if (byKey.has(key)) {
      warnings.push({
        kind: 'duplicate-key',
        jiraKey: key,
        message: `${key} appears more than once; kept the first row.`,
      });
      continue;
    }

    const summary = valueOf(row, mapping, 'summary') ?? key;
    const issueType = valueOf(row, mapping, 'issueType');

    const rawStart = valueOf(row, mapping, 'startDate');
    const rawDue = valueOf(row, mapping, 'dueDate');
    const start = rawStart ? parseJiraDate(rawStart, options.dayFirst) : null;
    const due = rawDue ? parseJiraDate(rawDue, options.dayFirst) : null;

    if (rawStart && !start) {
      warnings.push({
        kind: 'unparsed-date',
        jiraKey: key,
        message: `Could not read the start date “${rawStart}” on ${key}; it was ignored.`,
      });
    }
    if (rawDue && !due) {
      warnings.push({
        kind: 'unparsed-date',
        jiraKey: key,
        message: `Could not read the due date “${rawDue}” on ${key}; it was ignored.`,
      });
    }

    const points = toNumber(valueOf(row, mapping, 'storyPoints'));
    const estimateSeconds = toNumber(valueOf(row, mapping, 'originalEstimate'));

    // Only an explicit issue type makes a milestone. Inferring one from "has a due date
    // and no estimate" was tempting, but that describes most ordinary Jira tickets —
    // it would silently turn real work into zero-duration markers.
    const isMilestone = issueType !== null && MILESTONE_TYPES.test(issueType);

    let durationDays: number;
    let durationSource: DurationSource;

    if (isMilestone) {
      durationDays = 0;
      durationSource = 'milestone';
    } else if (start && due) {
      if (due.day < start.day) {
        warnings.push({
          kind: 'end-before-start',
          jiraKey: key,
          message: `${key} has a due date before its start date; used the default duration.`,
        });
        durationDays = options.defaultDurationDays;
        durationSource = 'default';
      } else {
        durationDays = calendar.workingDaysBetween(
          calendar.snapForward(start.day),
          calendar.snapBack(due.day),
        );
        durationSource = 'both-dates';
      }
    } else if (estimateSeconds > 0) {
      durationDays = Math.max(1, Math.round(estimateSeconds / SECONDS_PER_WORKING_DAY));
      durationSource = 'original-estimate';
    } else if (points > 0) {
      durationDays = Math.max(1, Math.round(points * options.pointsToDays));
      durationSource = 'story-points';
    } else if (due) {
      durationDays = options.defaultDurationDays;
      durationSource = 'due-date-only';
    } else {
      durationDays = options.defaultDurationDays;
      durationSource = 'default';
    }

    // A task with a due date but no start still needs an anchor, so work backwards.
    const anchorDay = start
      ? calendar.snapForward(start.day)
      : due
        ? isMilestone
          ? calendar.snapForward(due.day)
          : calendar.startFromEnd(calendar.snapBack(due.day), durationDays)
        : null;

    const assigneeNames = valuesOf(row, mapping, 'assignee');
    const assigneeIds: string[] = [];
    for (const name of assigneeNames) {
      const id = resourceIdFor(name);
      assigneeIds.push(id);
      if (!resourceIds.has(id)) resourceIds.set(id, { id, name, capacity: 1 });
    }

    const phase =
      valuesOf(row, mapping, 'sprint').at(-1) ?? valuesOf(row, mapping, 'labels')[0];

    const task: Task = {
      id: key,
      jiraKey: key,
      name: summary,
      parentId: null,
      durationDays,
      percentComplete: 0,
      status: mapStatus(valueOf(row, mapping, 'status')),
      priority: mapPriority(valueOf(row, mapping, 'priority')),
      assigneeIds,
      ...(phase ? { phase } : {}),
    };

    // A done issue is 100% complete; that is the only progress signal a CSV carries.
    if (task.status === 'done') task.percentComplete = 100;

    if (anchorDay !== null && options.pinImportedStarts) {
      task.constraint = { type: 'SNET', day: anchorDay };
    }
    if (anchorDay !== null && (earliestStart === null || anchorDay < earliestStart)) {
      earliestStart = anchorDay;
    }

    const draft: Draft = {
      task,
      parentKey: valueOf(row, mapping, 'parent') ?? valueOf(row, mapping, 'epicLink'),
      blocks: valuesOf(row, mapping, 'blocks'),
      blockedBy: valuesOf(row, mapping, 'blockedBy'),
    };

    drafts.push(draft);
    byKey.set(key, draft);
    notes.push({
      taskId: key,
      jiraKey: key,
      durationSource,
      durationDays,
      pinned: anchorDay !== null && options.pinImportedStarts,
    });
  }

  // ── Pass two: hierarchy ────────────────────────────────────────────────────────
  for (const draft of drafts) {
    if (!draft.parentKey) continue;
    // A parent reference may be a key, or a summary if the export used `Parent summary`.
    const parent = byKey.get(draft.parentKey) ?? findByName(drafts, draft.parentKey);
    if (!parent) {
      warnings.push({
        kind: 'unknown-parent',
        jiraKey: draft.task.jiraKey,
        message: `${draft.task.jiraKey} names parent “${draft.parentKey}”, which is not in this export; left at the top level.`,
      });
      continue;
    }
    if (parent === draft) continue;
    draft.task.parentId = parent.task.id;
  }

  // A summary task's dates are derived, so an imported anchor on one is meaningless.
  const parentIds = new Set(drafts.map((d) => d.task.parentId).filter(Boolean) as string[]);
  for (const draft of drafts) {
    if (!parentIds.has(draft.task.id)) continue;
    delete draft.task.constraint;
    if (draft.task.durationDays === 0) continue;
    // Keep the stored duration; the scheduler ignores it for summary rows anyway.
  }

  // ── Pass three: dependencies ───────────────────────────────────────────────────
  const dependencies: Dependency[] = [];
  const seen = new Set<string>();
  let depCounter = 0;

  /** Leaf descendants of a task, or the task itself when it has no children. */
  const childrenOf = new Map<string, string[]>();
  for (const draft of drafts) {
    if (!draft.task.parentId) continue;
    let list = childrenOf.get(draft.task.parentId);
    if (!list) childrenOf.set(draft.task.parentId, (list = []));
    list.push(draft.task.id);
  }
  const leavesOf = (id: string): string[] => {
    const leaves: string[] = [];
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const children = childrenOf.get(current);
      if (!children || children.length === 0) {
        leaves.push(current);
        continue;
      }
      stack.push(...children);
    }
    return leaves;
  };

  const addLink = (predecessorId: string, successorId: string) => {
    if (predecessorId === successorId) return;
    const signature = `${predecessorId}→${successorId}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    dependencies.push({
      id: `d${++depCounter}`,
      predecessorId,
      successorId,
      type: 'FS',
      lagDays: 0,
    });
  };

  const link = (predecessorKey: string, successorKey: string, sourceKey: string) => {
    const predecessor = byKey.get(predecessorKey);
    const successor = byKey.get(successorKey);
    if (!predecessor || !successor) {
      const missing = predecessor ? successorKey : predecessorKey;
      warnings.push({
        kind: 'unknown-link-target',
        jiraKey: sourceKey,
        message: `${sourceKey} links to ${missing}, which is not in this export; the dependency was skipped.`,
      });
      return;
    }
    if (predecessor === successor) return;

    /*
     * A summary task's dates are derived from its children, so it cannot be a
     * successor. But Jira teams routinely hang `blocks` links off epics, and blocking
     * an epic plainly means blocking the work inside it — so the link is expanded onto
     * the epic's leaf children rather than dropped. That mirrors how the scheduler
     * already treats a summary *predecessor*, keeping both directions symmetric.
     */
    const successorLeaves = parentIds.has(successor.task.id)
      ? leavesOf(successor.task.id)
      : [successor.task.id];

    if (successorLeaves.length > 1 || successorLeaves[0] !== successor.task.id) {
      warnings.push({
        kind: 'summary-successor-expanded',
        jiraKey: sourceKey,
        message: `${sourceKey} blocks ${successorKey}, which has children — the link was applied to its ${successorLeaves.length} leaf task(s) instead.`,
      });
    }

    for (const leaf of successorLeaves) {
      // A parent cannot depend on its own descendant, so skip any such pairing.
      if (isAncestorOf(predecessor.task.id, leaf)) continue;
      addLink(predecessor.task.id, leaf);
    }
  };

  /** Walks up the imported parent chain. */
  function isAncestorOf(ancestorId: string, descendantId: string): boolean {
    let cursor = byKey.get(descendantId)?.task.parentId ?? null;
    while (cursor !== null) {
      if (cursor === ancestorId) return true;
      cursor = byKey.get(cursor)?.task.parentId ?? null;
    }
    return false;
  }

  for (const draft of drafts) {
    for (const target of draft.blocks) link(draft.task.id, cleanKey(target), draft.task.id);
    for (const source of draft.blockedBy) link(cleanKey(source), draft.task.id, draft.task.id);
  }

  const tasks = drafts.map((d) => d.task);
  const milestones = tasks.filter((t) => t.durationDays === 0 && !parentIds.has(t.id)).length;

  const project: Project = {
    id: 'imported',
    name: options.projectName ?? 'Imported from Jira',
    startDate: toISO(earliestStart ?? calendar.snapForward(todayIsoDay())),
    calendar: calendarSource,
    tasks,
    dependencies,
    resources: [...resourceIds.values()],
    baselines: [],
    activeBaselineId: null,
    settings: {
      ...DEFAULT_SETTINGS,
      pointsToDays: options.pointsToDays,
      defaultDurationDays: options.defaultDurationDays,
    },
  };

  return {
    project,
    notes,
    warnings,
    stats: {
      rows: rows.length,
      tasks: tasks.length,
      milestones,
      summaries: parentIds.size,
      dependencies: dependencies.length,
      resources: project.resources.length,
    },
  };
}

/** Jira renders a link cell as the bare key, but some exports add the summary. */
function cleanKey(value: string): string {
  return value.trim().split(/\s+/)[0]!.replace(/[,;]$/, '');
}

function findByName(drafts: readonly { task: Task }[], name: string) {
  const needle = name.trim().toLowerCase();
  return drafts.find((d) => d.task.name.trim().toLowerCase() === needle);
}

function resourceIdFor(name: string): string {
  return `r-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function toNumber(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapStatus(raw: string | null): TaskStatus {
  if (!raw) return 'not-started';
  const value = raw.trim();
  for (const [pattern, status] of STATUS_BY_CATEGORY) {
    if (pattern.test(value)) return status;
  }
  return 'not-started';
}

function mapPriority(raw: string | null): Priority {
  if (!raw) return 'medium';
  const value = raw.trim();
  for (const [pattern, priority] of PRIORITY_BY_NAME) {
    if (pattern.test(value)) return priority;
  }
  return 'medium';
}

/** Local today as a day number. Only reached when an export has no dates at all. */
function todayIsoDay(): number {
  const now = new Date();
  return Math.floor(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000,
  );
}
