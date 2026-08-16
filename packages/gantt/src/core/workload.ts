/**
 * Resource workload — who is over-allocated, and when.
 *
 * Each assignee carries one unit of load per working day for the whole span of every
 * leaf task assigned to them. Load is *not* divided between co-assignees: two people
 * on the same task are both busy that week, and halving their load would hide exactly
 * the double-booking this view exists to surface.
 *
 * Summary tasks are skipped — their span is their children's, so counting both would
 * double-book everyone.
 */

import type { CompiledCalendar } from './calendar.js';
import type { DayNum } from './day.js';
import type { Project, ScheduleResult } from './types.js';

export interface DayLoad {
  day: DayNum;
  /** Units of work assigned on this day. */
  load: number;
  capacity: number;
  taskIds: string[];
}

export interface ResourceLoad {
  resourceId: string;
  name: string;
  capacity: number;
  /** Only days with non-zero load, ascending. */
  days: DayLoad[];
  peakLoad: number;
  overAllocatedDays: number;
  /** Working days where load exceeds capacity. */
  overAllocatedDayNums: DayNum[];
  totalAssignedDays: number;
}

export interface WorkloadResult {
  resources: ResourceLoad[];
  /** Assignee ids found on tasks that have no matching resource record. */
  unknownAssigneeIds: string[];
  from: DayNum;
  to: DayNum;
}

export function computeWorkload(
  project: Project,
  result: ScheduleResult,
  calendar: CompiledCalendar,
): WorkloadResult {
  const capacityOf = new Map<string, number>();
  const nameOf = new Map<string, string>();
  for (const resource of project.resources) {
    capacityOf.set(resource.id, resource.capacity > 0 ? resource.capacity : 1);
    nameOf.set(resource.id, resource.name);
  }

  const perResource = new Map<string, Map<DayNum, { load: number; taskIds: string[] }>>();
  const unknown = new Set<string>();

  for (const task of project.tasks) {
    const scheduled = result.tasks.get(task.id);
    if (!scheduled || scheduled.kind === 'summary') continue;
    if (task.assigneeIds.length === 0) continue;

    for (const assigneeId of task.assigneeIds) {
      if (!capacityOf.has(assigneeId)) unknown.add(assigneeId);
      let byDay = perResource.get(assigneeId);
      if (!byDay) perResource.set(assigneeId, (byDay = new Map()));

      for (let day = scheduled.start; day <= scheduled.end; day++) {
        if (!calendar.isWorkingDay(day)) continue;
        let cell = byDay.get(day);
        if (!cell) byDay.set(day, (cell = { load: 0, taskIds: [] }));
        cell.load += 1;
        cell.taskIds.push(task.id);
      }
    }
  }

  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;

  const resources: ResourceLoad[] = [];
  for (const [resourceId, byDay] of perResource) {
    const capacity = capacityOf.get(resourceId) ?? 1;
    const days: DayLoad[] = [...byDay.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([day, cell]) => ({ day, load: cell.load, capacity, taskIds: cell.taskIds }));

    let peakLoad = 0;
    const overAllocatedDayNums: DayNum[] = [];
    for (const entry of days) {
      if (entry.load > peakLoad) peakLoad = entry.load;
      if (entry.load > capacity) overAllocatedDayNums.push(entry.day);
      if (entry.day < from) from = entry.day;
      if (entry.day > to) to = entry.day;
    }

    resources.push({
      resourceId,
      name: nameOf.get(resourceId) ?? resourceId,
      capacity,
      days,
      peakLoad,
      overAllocatedDays: overAllocatedDayNums.length,
      overAllocatedDayNums,
      totalAssignedDays: days.length,
    });
  }

  resources.sort(
    (a, b) => b.overAllocatedDays - a.overAllocatedDays || a.name.localeCompare(b.name),
  );

  return {
    resources,
    unknownAssigneeIds: [...unknown],
    from: Number.isFinite(from) ? from : result.projectStart,
    to: Number.isFinite(to) ? to : result.projectFinish,
  };
}
