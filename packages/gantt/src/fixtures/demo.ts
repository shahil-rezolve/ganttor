/**
 * The bundled sample project.
 *
 * It does double duty: it is what Ganttor opens with on a first run, and it is the
 * dataset the density and critical-path invariant tests run against. So it is built
 * to be *awkward* on purpose — four epics of uneven length, two milestones, a
 * deliberately over-allocated engineer, one at-risk branch with plenty of float, and
 * all four dependency types including a lead and a lag.
 *
 * `PROJECT_START` is a Monday, which keeps hand-checking the working-day arithmetic
 * straightforward.
 */

import { DEFAULT_CALENDAR } from '../core/calendar.js';
import { toDayNum, type ISODate } from '../core/day.js';
import { DEFAULT_SETTINGS, type Dependency, type Project, type Resource, type Task } from '../core/types.js';

export const PROJECT_START: ISODate = '2026-03-02';

const RESOURCES: Resource[] = [
  { id: 'r-priya', name: 'Priya Raman', capacity: 1, colorIndex: 0 },
  { id: 'r-tom', name: 'Tom Okafor', capacity: 1, colorIndex: 1 },
  { id: 'r-lena', name: 'Lena Brandt', capacity: 1, colorIndex: 2 },
  { id: 'r-sam', name: 'Sam Ito', capacity: 1, colorIndex: 3 },
  { id: 'r-dev', name: 'Devon Clarke', capacity: 1, colorIndex: 4 },
];

type TaskSeed = Omit<Task, 'percentComplete' | 'status' | 'priority' | 'assigneeIds'> &
  Partial<Pick<Task, 'percentComplete' | 'status' | 'priority' | 'assigneeIds'>>;

const seed = (task: TaskSeed): Task => ({
  percentComplete: 0,
  status: 'not-started',
  priority: 'medium',
  assigneeIds: [],
  ...task,
});

const TASKS: Task[] = [
  // ── Epic: Discovery ───────────────────────────────────────────────────────────
  seed({ id: 'e-disc', jiraKey: 'GNT-1', name: 'Discovery', parentId: null, durationDays: 0, phase: 'Discovery' }),
  seed({
    id: 't-interviews',
    jiraKey: 'GNT-2',
    name: 'Stakeholder interviews',
    parentId: 'e-disc',
    durationDays: 4,
    percentComplete: 100,
    status: 'done',
    priority: 'high',
    assigneeIds: ['r-priya'],
    phase: 'Discovery',
  }),
  seed({
    id: 't-audit',
    jiraKey: 'GNT-3',
    name: 'Audit existing Jira workflows',
    parentId: 'e-disc',
    durationDays: 3,
    percentComplete: 100,
    status: 'done',
    assigneeIds: ['r-tom'],
    phase: 'Discovery',
  }),
  seed({
    id: 't-req',
    jiraKey: 'GNT-4',
    name: 'Write requirements brief',
    parentId: 'e-disc',
    durationDays: 3,
    percentComplete: 60,
    status: 'on-track',
    priority: 'high',
    assigneeIds: ['r-priya'],
    phase: 'Discovery',
  }),
  seed({
    id: 'm-signoff',
    jiraKey: 'GNT-5',
    name: 'Requirements signed off',
    parentId: 'e-disc',
    durationDays: 0,
    priority: 'highest',
    phase: 'Discovery',
  }),

  // ── Epic: Scheduling engine ───────────────────────────────────────────────────
  seed({ id: 'e-engine', jiraKey: 'GNT-10', name: 'Scheduling engine', parentId: null, durationDays: 0, phase: 'Engine' }),
  seed({
    id: 't-model',
    jiraKey: 'GNT-11',
    name: 'Task and dependency data model',
    parentId: 'e-engine',
    durationDays: 3,
    percentComplete: 100,
    status: 'done',
    priority: 'high',
    assigneeIds: ['r-lena'],
    phase: 'Engine',
  }),
  seed({
    id: 't-calendar',
    jiraKey: 'GNT-12',
    name: 'Working calendar and duration math',
    parentId: 'e-engine',
    durationDays: 4,
    percentComplete: 80,
    status: 'on-track',
    assigneeIds: ['r-lena'],
    phase: 'Engine',
  }),
  seed({
    id: 't-forward',
    jiraKey: 'GNT-13',
    name: 'Forward pass and auto-rescheduling',
    parentId: 'e-engine',
    durationDays: 6,
    percentComplete: 45,
    status: 'on-track',
    priority: 'highest',
    assigneeIds: ['r-lena'],
    phase: 'Engine',
  }),
  seed({
    id: 't-cycles',
    jiraKey: 'GNT-14',
    name: 'Circular dependency detection',
    parentId: 'e-engine',
    durationDays: 2,
    status: 'not-started',
    assigneeIds: ['r-sam'],
    phase: 'Engine',
  }),
  seed({
    id: 't-cpm',
    jiraKey: 'GNT-15',
    name: 'Critical path calculation',
    parentId: 'e-engine',
    durationDays: 5,
    priority: 'highest',
    status: 'not-started',
    assigneeIds: ['r-lena'],
    phase: 'Engine',
  }),
  seed({
    id: 't-engine-tests',
    jiraKey: 'GNT-16',
    name: 'Verification suite against CRITERIA',
    parentId: 'e-engine',
    durationDays: 4,
    priority: 'high',
    assigneeIds: ['r-sam'],
    phase: 'Engine',
  }),

  // ── Epic: Chart rendering ─────────────────────────────────────────────────────
  seed({ id: 'e-chart', jiraKey: 'GNT-20', name: 'Chart rendering', parentId: null, durationDays: 0, phase: 'Chart' }),
  seed({
    id: 't-grid',
    jiraKey: 'GNT-21',
    name: 'Task grid and WBS tree',
    parentId: 'e-chart',
    durationDays: 4,
    percentComplete: 30,
    status: 'on-track',
    assigneeIds: ['r-tom'],
    phase: 'Chart',
  }),
  seed({
    id: 't-timeline',
    jiraKey: 'GNT-22',
    name: 'Timeline header and zoom scales',
    parentId: 'e-chart',
    durationDays: 5,
    assigneeIds: ['r-tom'],
    phase: 'Chart',
  }),
  seed({
    id: 't-bars',
    jiraKey: 'GNT-23',
    name: 'Bars, progress fill, milestones',
    parentId: 'e-chart',
    durationDays: 4,
    priority: 'high',
    assigneeIds: ['r-dev'],
    phase: 'Chart',
  }),
  seed({
    id: 't-arrows',
    jiraKey: 'GNT-24',
    name: 'Dependency arrow overlay',
    parentId: 'e-chart',
    durationDays: 4,
    priority: 'high',
    assigneeIds: ['r-dev'],
    phase: 'Chart',
  }),
  seed({
    id: 't-drag',
    jiraKey: 'GNT-25',
    name: 'Drag to reschedule and resize',
    parentId: 'e-chart',
    durationDays: 5,
    priority: 'highest',
    assigneeIds: ['r-dev'],
    phase: 'Chart',
  }),
  seed({
    id: 't-theme',
    jiraKey: 'GNT-26',
    name: 'Dark and light theming pass',
    parentId: 'e-chart',
    durationDays: 2,
    priority: 'low',
    status: 'not-started',
    assigneeIds: ['r-tom'],
    phase: 'Chart',
  }),

  // ── Epic: Jira import and persistence ─────────────────────────────────────────
  seed({ id: 'e-jira', jiraKey: 'GNT-30', name: 'Jira import & persistence', parentId: null, durationDays: 0, phase: 'Import' }),
  seed({
    id: 't-csv',
    jiraKey: 'GNT-31',
    name: 'Jira CSV parser and column mapping',
    parentId: 'e-jira',
    durationDays: 5,
    priority: 'high',
    assigneeIds: ['r-sam'],
    phase: 'Import',
  }),
  seed({
    id: 't-links',
    jiraKey: 'GNT-32',
    name: 'Map issue links to dependencies',
    parentId: 'e-jira',
    durationDays: 3,
    assigneeIds: ['r-sam'],
    phase: 'Import',
  }),
  seed({
    id: 't-persist',
    jiraKey: 'GNT-33',
    name: 'IndexedDB autosave and JSON export',
    parentId: 'e-jira',
    durationDays: 3,
    assigneeIds: ['r-dev'],
    phase: 'Import',
  }),
  seed({
    id: 't-workload',
    jiraKey: 'GNT-34',
    name: 'Resource workload view',
    parentId: 'e-jira',
    durationDays: 4,
    priority: 'low',
    status: 'at-risk',
    assigneeIds: ['r-priya'],
    phase: 'Import',
  }),
  seed({
    id: 'm-ship',
    jiraKey: 'GNT-40',
    name: 'Ship v1',
    parentId: null,
    durationDays: 0,
    priority: 'highest',
    phase: 'Release',
  }),
];

const dep = (
  id: string,
  predecessorId: string,
  successorId: string,
  type: Dependency['type'] = 'FS',
  lagDays = 0,
): Dependency => ({ id, predecessorId, successorId, type, lagDays });

const DEPENDENCIES: Dependency[] = [
  // Discovery is a straight chain into a signed-off milestone.
  dep('d-1', 't-interviews', 't-req'),
  dep('d-2', 't-audit', 't-req'),
  dep('d-3', 't-req', 'm-signoff'),

  // The engine chain is the intended critical path.
  dep('d-4', 'm-signoff', 't-model'),
  dep('d-5', 't-model', 't-calendar'),
  dep('d-6', 't-calendar', 't-forward'),
  // Cycle detection can start as soon as the forward pass does — it shares its graph code.
  dep('d-7', 't-forward', 't-cycles', 'SS', 2),
  dep('d-8', 't-forward', 't-cpm'),
  // Tests finish alongside the CPM work rather than after it.
  dep('d-9', 't-cpm', 't-engine-tests', 'FF', 1),

  // The chart can be started before the engine lands, but bars need the data model.
  dep('d-10', 't-model', 't-grid'),
  dep('d-11', 't-grid', 't-timeline'),
  dep('d-12', 't-timeline', 't-bars'),
  dep('d-13', 't-bars', 't-arrows'),
  // Drag work overlaps the arrow work by two days — a lead.
  dep('d-14', 't-arrows', 't-drag', 'FS', -2),
  dep('d-15', 't-drag', 't-theme'),

  // Import work depends on the model, and persistence on the drag work that produces edits.
  dep('d-16', 'm-signoff', 't-csv'),
  dep('d-17', 't-csv', 't-links'),
  dep('d-18', 't-drag', 't-persist'),
  dep('d-19', 't-links', 't-workload', 'SS', 1),

  // Release waits on the whole engine and chart, and on persistence.
  dep('d-20', 't-engine-tests', 'm-ship'),
  dep('d-21', 't-theme', 'm-ship'),
  dep('d-22', 't-persist', 'm-ship'),
  dep('d-23', 't-cycles', 'm-ship'),
];

export function createDemoProject(): Project {
  return {
    id: 'demo',
    name: 'Ganttor v1',
    startDate: PROJECT_START,
    calendar: {
      ...DEFAULT_CALENDAR,
      // A public holiday inside the plan, so the working-day math is visibly exercised.
      holidays: ['2026-04-03'],
    },
    tasks: TASKS.map((task) => ({ ...task, assigneeIds: [...task.assigneeIds] })),
    dependencies: DEPENDENCIES.map((d) => ({ ...d })),
    resources: RESOURCES.map((r) => ({ ...r })),
    baselines: [],
    activeBaselineId: null,
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** Day number of the demo project's start date. Handy in tests. */
export const DEMO_START_DAY = toDayNum(PROJECT_START);
