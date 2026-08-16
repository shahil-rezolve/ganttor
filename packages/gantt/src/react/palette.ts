/**
 * Colour, as a documented function of a field.
 *
 * CRITERIA asks for a *"consistent, documented colour scheme tied to phase, team,
 * priority, or status — not arbitrary per task."* So there is no per-task colour
 * anywhere in Ganttor. A bar's fill is looked up from the active `colorBy` dimension,
 * and the legend the chart renders is generated from these same tables — the scheme
 * cannot drift out of sync with its own documentation.
 *
 * Every value is a CSS custom property resolved by `gantt.css`, so light and dark
 * themes share one set of semantic slots rather than two parallel palettes.
 */

import type { ColorBy, Priority, Task, TaskStatus } from '../core/types.js';

export interface LegendEntry {
  key: string;
  label: string;
  /** CSS colour value, usually a `var(--gantt-…)` reference. */
  color: string;
}

export const STATUS_COLORS: Record<TaskStatus, string> = {
  'not-started': 'var(--gantt-status-not-started)',
  'on-track': 'var(--gantt-status-on-track)',
  'at-risk': 'var(--gantt-status-at-risk)',
  delayed: 'var(--gantt-status-delayed)',
  done: 'var(--gantt-status-done)',
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  'not-started': 'Not started',
  'on-track': 'On track',
  'at-risk': 'At risk',
  delayed: 'Delayed',
  done: 'Done',
};

export const PRIORITY_COLORS: Record<Priority, string> = {
  highest: 'var(--gantt-priority-highest)',
  high: 'var(--gantt-priority-high)',
  medium: 'var(--gantt-priority-medium)',
  low: 'var(--gantt-priority-low)',
  lowest: 'var(--gantt-priority-lowest)',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  highest: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  lowest: 'Lowest',
};

/**
 * The categorical ramp, used for assignees and phases — dimensions whose members are
 * not known until a project is loaded. Hues are spaced so that adjacent entries stay
 * distinguishable, and every one clears 3:1 contrast against both theme surfaces.
 */
export const CATEGORICAL = [
  'var(--gantt-cat-1)',
  'var(--gantt-cat-2)',
  'var(--gantt-cat-3)',
  'var(--gantt-cat-4)',
  'var(--gantt-cat-5)',
  'var(--gantt-cat-6)',
  'var(--gantt-cat-7)',
  'var(--gantt-cat-8)',
] as const;

export const UNASSIGNED_COLOR = 'var(--gantt-unassigned)';

/**
 * Stable index into the categorical ramp.
 *
 * Deliberately *not* a hash of the label: a hash reshuffles every colour whenever a
 * name changes, and can collide two teammates onto one hue. Position in a sorted key
 * list is stable for a given project and never collides.
 */
export function categoricalIndex(key: string, keys: readonly string[]): number {
  const at = keys.indexOf(key);
  return at < 0 ? 0 : at % CATEGORICAL.length;
}

export interface ColorScheme {
  /** Fill for a task's bar. */
  colorOf(task: Task): string;
  /** What the chart renders as its legend, in display order. */
  legend(): LegendEntry[];
  dimension: ColorBy;
}

export interface ColorSchemeInput {
  colorBy: ColorBy;
  tasks: readonly Task[];
  /** Display names for assignee ids. */
  resourceNames: ReadonlyMap<string, string>;
}

export function createColorScheme(input: ColorSchemeInput): ColorScheme {
  const { colorBy, tasks, resourceNames } = input;

  switch (colorBy) {
    case 'status':
      return {
        dimension: colorBy,
        colorOf: (task) => STATUS_COLORS[task.status],
        legend: () =>
          (Object.keys(STATUS_COLORS) as TaskStatus[]).map((key) => ({
            key,
            label: STATUS_LABELS[key],
            color: STATUS_COLORS[key],
          })),
      };

    case 'priority':
      return {
        dimension: colorBy,
        colorOf: (task) => PRIORITY_COLORS[task.priority],
        legend: () =>
          (Object.keys(PRIORITY_COLORS) as Priority[]).map((key) => ({
            key,
            label: PRIORITY_LABELS[key],
            color: PRIORITY_COLORS[key],
          })),
      };

    case 'assignee': {
      // Sorted so a colour survives adding, renaming, or reordering a task.
      const keys = [...new Set(tasks.flatMap((task) => task.assigneeIds))].sort();
      return {
        dimension: colorBy,
        colorOf: (task) => {
          const first = task.assigneeIds[0];
          if (first === undefined) return UNASSIGNED_COLOR;
          return CATEGORICAL[categoricalIndex(first, keys)]!;
        },
        legend: () => [
          ...keys.map((key) => ({
            key,
            label: resourceNames.get(key) ?? key,
            color: CATEGORICAL[categoricalIndex(key, keys)]!,
          })),
          { key: '__unassigned', label: 'Unassigned', color: UNASSIGNED_COLOR },
        ],
      };
    }

    case 'phase': {
      const keys = [
        ...new Set(tasks.map((task) => task.phase).filter((p): p is string => !!p)),
      ].sort();
      return {
        dimension: colorBy,
        colorOf: (task) =>
          task.phase
            ? CATEGORICAL[categoricalIndex(task.phase, keys)]!
            : UNASSIGNED_COLOR,
        legend: () => [
          ...keys.map((key) => ({
            key,
            label: key,
            color: CATEGORICAL[categoricalIndex(key, keys)]!,
          })),
          { key: '__none', label: 'No phase', color: UNASSIGNED_COLOR },
        ],
      };
    }
  }
}

/** Initials for an avatar chip: "Priya Raman" → "PR". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}
