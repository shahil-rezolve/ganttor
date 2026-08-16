/**
 * Test kit: build a project from a terse description so a scheduling test reads as a
 * statement about scheduling rather than as object-literal plumbing.
 *
 * `wd(n)` is the n-th *working* day from the project start, which is the unit every
 * expectation in the suite is written in. Absolute dates would make the tests depend
 * on which weekday the fixture happens to begin on.
 */

import { compileCalendar, DEFAULT_CALENDAR, type WorkCalendar } from '../core/calendar.js';
import { toDayNum, type DayNum, type ISODate } from '../core/day.js';
import {
  DEFAULT_SETTINGS,
  type DepType,
  type Dependency,
  type Priority,
  type Project,
  type Task,
  type TaskStatus,
} from '../core/types.js';

/** A Monday, so working-day expectations are easy to check by eye. */
export const KIT_START: ISODate = '2026-03-02';

export interface TaskSpec {
  id: string;
  /** Working days. 0 makes it a milestone. */
  dur: number;
  parent?: string;
  pct?: number;
  /** Start-no-earlier-than, as a working-day index from the project start. */
  snet?: number;
  /** Must-start-on, as a working-day index from the project start. */
  mso?: number;
  assignees?: string[];
  status?: TaskStatus;
  priority?: Priority;
  name?: string;
}

/** `[predecessor, successor, type?, lag?]` */
export type DepSpec = [string, string, DepType?, number?];

export interface BuildProjectOptions {
  start?: ISODate;
  calendar?: WorkCalendar;
  tasks: TaskSpec[];
  deps?: DepSpec[];
  resources?: { id: string; name?: string; capacity?: number }[];
}

export function buildProject(options: BuildProjectOptions): Project {
  const startDate = options.start ?? KIT_START;
  const calendar = options.calendar ?? DEFAULT_CALENDAR;
  const day = workingDayIndexer(startDate, calendar);

  const tasks: Task[] = options.tasks.map((spec) => {
    const task: Task = {
      id: spec.id,
      name: spec.name ?? spec.id,
      parentId: spec.parent ?? null,
      durationDays: spec.dur,
      percentComplete: spec.pct ?? 0,
      status: spec.status ?? 'not-started',
      priority: spec.priority ?? 'medium',
      assigneeIds: spec.assignees ?? [],
    };
    if (spec.mso !== undefined) task.constraint = { type: 'MSO', day: day(spec.mso) };
    else if (spec.snet !== undefined) task.constraint = { type: 'SNET', day: day(spec.snet) };
    return task;
  });

  const dependencies: Dependency[] = (options.deps ?? []).map(
    ([predecessorId, successorId, type, lag], index): Dependency => ({
      id: `d${index + 1}`,
      predecessorId,
      successorId,
      type: type ?? 'FS',
      lagDays: lag ?? 0,
    }),
  );

  return {
    id: 'kit',
    name: 'kit',
    startDate,
    calendar,
    tasks,
    dependencies,
    resources: (options.resources ?? []).map((r) => ({
      id: r.id,
      name: r.name ?? r.id,
      capacity: r.capacity ?? 1,
    })),
    baselines: [],
    activeBaselineId: null,
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** `wd(0)` is the project's first working day, `wd(1)` the next, and so on. */
export function workingDayIndexer(
  startDate: ISODate,
  calendarSource: WorkCalendar = DEFAULT_CALENDAR,
): (n: number) => DayNum {
  const calendar = compileCalendar(calendarSource);
  const first = calendar.snapForward(toDayNum(startDate));
  return (n: number) => calendar.ceilShift(first, n);
}

/** Working-day index of a day number, inverse of `workingDayIndexer`. */
export function workingDayIndexOf(
  startDate: ISODate,
  day: DayNum,
  calendarSource: WorkCalendar = DEFAULT_CALENDAR,
): number {
  const calendar = compileCalendar(calendarSource);
  const first = calendar.snapForward(toDayNum(startDate));
  return calendar.workingDayDelta(first, day);
}
