/**
 * Application state.
 *
 * The store holds the project document and an undo stack, and every mutation goes
 * through `commit()`. Two consequences worth stating:
 *
 * - **Undo is document-level.** Because `project.ts` mutations are all pure
 *   `Project → Project`, undo is just keeping previous values. No inverse operations to
 *   write, nothing to get wrong.
 * - **Rejections surface as a `notice`.** Adding a dependency can fail (a cycle), and
 *   the store is where that message lands so the chart itself stays presentational.
 *
 * Autosave is debounced and fire-and-forget: a failed write should never interrupt
 * editing, so it reports through `notice` rather than throwing.
 */

import { create } from 'zustand';

import {
  activeBaseline,
  addDependency as addDependencyOp,
  addTask as addTaskOp,
  createBaseline,
  indentTask as indentTaskOp,
  makeId,
  moveTask as moveTaskOp,
  newDependencyId,
  newTaskId,
  outdentTask as outdentTaskOp,
  pinTaskDates,
  removeBaseline as removeBaselineOp,
  removeDependency as removeDependencyOp,
  removeTask as removeTaskOp,
  schedule,
  setConstraint as setConstraintOp,
  saveBaseline as saveBaselineOp,
  updateDependency as updateDependencyOp,
  updateTask as updateTaskOp,
  type ColorBy,
  type DepType,
  type ISODate,
  type Project,
  type ScaleUnit,
  type Task,
  type TaskDates,
  type WorkCalendar,
} from '@ganttor/gantt';

import { createDemoProject } from '@ganttor/gantt';
import { downloadProject, loadProject, saveProject } from './persistence.js';

export type NoticeTone = 'info' | 'warn' | 'error' | 'success';

export interface Notice {
  id: number;
  tone: NoticeTone;
  message: string;
  /** Task ids to highlight, e.g. the members of a rejected cycle. */
  highlight?: string[];
}

const UNDO_LIMIT = 60;
const AUTOSAVE_DELAY_MS = 400;

export interface ProjectState {
  project: Project;
  unit: ScaleUnit;
  selectedTaskId: string | null;
  selectedDependencyId: string | null;
  theme: 'dark' | 'light';
  notice: Notice | null;
  /** True until the first IndexedDB read settles, so the UI can avoid a flash. */
  loading: boolean;
  lastSavedAt: string | null;

  past: Project[];
  future: Project[];

  // ── Lifecycle ──
  hydrate: () => Promise<void>;
  loadProjectDocument: (project: Project, message?: string) => void;
  resetToDemo: () => void;
  exportFile: () => void;

  // ── View ──
  setUnit: (unit: ScaleUnit) => void;
  setTheme: (theme: 'dark' | 'light') => void;
  selectTask: (taskId: string | null) => void;
  selectDependency: (dependencyId: string | null) => void;
  setColorBy: (colorBy: ColorBy) => void;
  toggleCriticalPath: () => void;
  toggleBaselineOverlay: () => void;
  toggleLock: () => void;
  dismissNotice: () => void;

  // ── Tasks ──
  addTask: (afterId?: string) => void;
  updateTask: (taskId: string, patch: Partial<Task>) => void;
  removeTask: (taskId: string) => void;
  toggleCollapse: (taskId: string) => void;
  indentTask: (taskId: string) => void;
  outdentTask: (taskId: string) => void;
  moveTask: (taskId: string, parentId: string | null, index?: number) => void;
  /** A bar was dragged or resized: pin the new dates. */
  applyDates: (taskId: string, dates: TaskDates) => void;
  clearConstraint: (taskId: string) => void;
  nudgeTask: (taskId: string, days: number) => void;

  // ── Dependencies ──
  createLink: (predecessorId: string, successorId: string) => void;
  updateLink: (dependencyId: string, patch: { type?: DepType; lagDays?: number }) => void;
  removeLink: (dependencyId: string) => void;

  // ── Baselines ──
  saveBaseline: (name?: string) => void;
  removeBaseline: (baselineId: string) => void;
  setActiveBaseline: (baselineId: string | null) => void;

  // ── Project settings ──
  renameProject: (name: string) => void;
  setProjectStart: (startDate: ISODate) => void;
  setCalendar: (calendar: WorkCalendar) => void;
  setPointsToDays: (value: number) => void;
  setDefaultDuration: (value: number) => void;

  // ── History ──
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

let noticeCounter = 0;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

export const useProjectStore = create<ProjectState>((set, get) => {
  /** Queue an autosave. Debounced so a drag does not write once per frame. */
  const scheduleAutosave = (project: Project) => {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      void saveProject(project)
        .then(() => set({ lastSavedAt: new Date().toISOString() }))
        .catch((error: unknown) => {
          set({
            notice: {
              id: ++noticeCounter,
              tone: 'error',
              message: `Could not autosave: ${describe(error)}`,
            },
          });
        });
    }, AUTOSAVE_DELAY_MS);
  };

  /** The single write path: push the old document onto the undo stack, then autosave. */
  const commit = (next: Project, notice?: Notice | null) => {
    const { project, past } = get();
    if (next === project) {
      if (notice !== undefined) set({ notice });
      return;
    }
    set({
      project: next,
      past: [...past.slice(-(UNDO_LIMIT - 1)), project],
      future: [],
      ...(notice !== undefined ? { notice } : {}),
    });
    scheduleAutosave(next);
  };

  /** A change that should not be undoable — view state, not document state. */
  const setView = (patch: Partial<Project>) => {
    const next = { ...get().project, ...patch };
    set({ project: next });
    scheduleAutosave(next);
  };

  const note = (tone: NoticeTone, message: string, highlight?: string[]): Notice => ({
    id: ++noticeCounter,
    tone,
    message,
    ...(highlight ? { highlight } : {}),
  });

  /** Names a task for a message: the Jira key if it has one, else its summary. */
  const label = (taskId: string): string => {
    const task = get().project.tasks.find((t) => t.id === taskId);
    return task?.jiraKey ?? task?.name ?? taskId;
  };

  return {
    project: createDemoProject(),
    unit: 'week',
    selectedTaskId: null,
    selectedDependencyId: null,
    theme: 'dark',
    notice: null,
    loading: true,
    lastSavedAt: null,
    past: [],
    future: [],

    hydrate: async () => {
      try {
        const stored = await loadProject();
        if (stored) {
          set({
            project: stored.project,
            lastSavedAt: stored.savedAt,
            loading: false,
            past: [],
            future: [],
          });
          return;
        }
      } catch (error) {
        set({
          notice: note(
            'warn',
            `Could not read the saved project (${describe(error)}). Started from the sample instead.`,
          ),
        });
      }
      set({ loading: false });
    },

    loadProjectDocument: (project, message) => {
      set({
        project,
        past: [],
        future: [],
        selectedTaskId: null,
        selectedDependencyId: null,
        ...(message ? { notice: note('success', message) } : {}),
      });
      scheduleAutosave(project);
    },

    resetToDemo: () => {
      const demo = createDemoProject();
      set({
        project: demo,
        past: [],
        future: [],
        selectedTaskId: null,
        selectedDependencyId: null,
        notice: note('info', 'Loaded the sample project.'),
      });
      scheduleAutosave(demo);
    },

    exportFile: () => {
      downloadProject(get().project);
      set({ notice: note('success', 'Exported the project as a .ganttor.json file.') });
    },

    setUnit: (unit) => set({ unit }),
    setTheme: (theme) => set({ theme }),
    selectTask: (selectedTaskId) => set({ selectedTaskId, selectedDependencyId: null }),
    selectDependency: (selectedDependencyId) =>
      set({ selectedDependencyId, selectedTaskId: null }),
    dismissNotice: () => set({ notice: null }),

    setColorBy: (colorBy) => setView({ settings: { ...get().project.settings, colorBy } }),
    toggleCriticalPath: () =>
      setView({
        settings: {
          ...get().project.settings,
          showCriticalPath: !get().project.settings.showCriticalPath,
        },
      }),
    toggleBaselineOverlay: () =>
      setView({
        settings: {
          ...get().project.settings,
          showBaseline: !get().project.settings.showBaseline,
        },
      }),
    toggleLock: () => {
      const locked = !get().project.settings.locked;
      setView({ settings: { ...get().project.settings, locked } });
      set({
        notice: note(
          'info',
          locked ? 'View-only: editing is disabled.' : 'Editing enabled.',
        ),
      });
    },

    addTask: (afterId) => {
      const project = get().project;
      const id = newTaskId(project);
      const parentId = afterId
        ? (project.tasks.find((t) => t.id === afterId)?.parentId ?? null)
        : null;
      commit(
        addTaskOp(
          project,
          { id, name: 'New task', parentId, durationDays: 3 },
          ...(afterId ? [{ afterId }] : []),
        ),
      );
      set({ selectedTaskId: id });
    },

    updateTask: (taskId, patch) => commit(updateTaskOp(get().project, taskId, patch)),

    removeTask: (taskId) => {
      commit(removeTaskOp(get().project, taskId));
      if (get().selectedTaskId === taskId) set({ selectedTaskId: null });
    },

    toggleCollapse: (taskId) => {
      const task = get().project.tasks.find((t) => t.id === taskId);
      if (!task) return;
      // Collapsing is a view preference, so it must not consume an undo slot.
      setView({
        tasks: get().project.tasks.map((t) =>
          t.id === taskId ? { ...t, collapsed: !task.collapsed } : t,
        ),
      });
    },

    indentTask: (taskId) => {
      const result = indentTaskOp(get().project, taskId);
      if (!result.ok) {
        set({ notice: note('warn', result.reason) });
        return;
      }
      commit(result.value, null);
    },

    outdentTask: (taskId) => {
      const result = outdentTaskOp(get().project, taskId);
      if (!result.ok) {
        set({ notice: note('warn', result.reason) });
        return;
      }
      commit(result.value, null);
    },

    moveTask: (taskId, parentId, index) => {
      const result = moveTaskOp(get().project, taskId, {
        parentId,
        ...(index !== undefined ? { index } : {}),
      });
      if (!result.ok) {
        set({ notice: note('warn', result.reason) });
        return;
      }
      commit(result.value, null);
    },

    applyDates: (taskId, dates) => commit(pinTaskDates(get().project, taskId, dates), null),

    clearConstraint: (taskId) => commit(setConstraintOp(get().project, taskId, null), null),

    nudgeTask: (taskId, days) => {
      const project = get().project;
      const scheduled = schedule(project).tasks.get(taskId);
      if (!scheduled || scheduled.kind === 'summary') return;
      commit(
        pinTaskDates(project, taskId, {
          start: scheduled.start + days,
          end: scheduled.end + days,
          durationDays: scheduled.durationDays,
        }),
        null,
      );
    },

    createLink: (predecessorId, successorId) => {
      const project = get().project;
      const result = addDependencyOp(project, {
        id: newDependencyId(project),
        predecessorId,
        successorId,
      });

      if (!result.ok) {
        // A rejected cycle names the tickets involved — that is the actionable part.
        const path = result.cycle?.map(label).join(' → ');
        set({
          notice: note(
            'error',
            path ? `${result.reason} (${path})` : result.reason,
            result.cycle,
          ),
        });
        return;
      }

      commit(
        result.value,
        note('success', `Linked ${label(predecessorId)} → ${label(successorId)}.`),
      );
    },

    updateLink: (dependencyId, patch) =>
      commit(updateDependencyOp(get().project, dependencyId, patch), null),

    removeLink: (dependencyId) => {
      commit(removeDependencyOp(get().project, dependencyId));
      if (get().selectedDependencyId === dependencyId) set({ selectedDependencyId: null });
    },

    saveBaseline: (name) => {
      const project = get().project;
      const id = makeId('b', project.baselines.map((b) => b.id));
      const baseline = createBaseline({
        id,
        name: name ?? `Baseline ${project.baselines.length + 1}`,
        savedAt: new Date().toISOString(),
        result: schedule(project),
      });
      commit(
        saveBaselineOp(project, baseline),
        note('success', `Saved “${baseline.name}”. The live schedule can now be compared against it.`),
      );
    },

    removeBaseline: (baselineId) => commit(removeBaselineOp(get().project, baselineId)),

    setActiveBaseline: (activeBaselineId) => {
      setView({
        activeBaselineId,
        settings: { ...get().project.settings, showBaseline: activeBaselineId !== null },
      });
    },

    renameProject: (name) => commit({ ...get().project, name }, null),
    setProjectStart: (startDate) => commit({ ...get().project, startDate }, null),
    setCalendar: (calendar) => commit({ ...get().project, calendar }, null),
    setPointsToDays: (pointsToDays) =>
      setView({ settings: { ...get().project.settings, pointsToDays } }),
    setDefaultDuration: (defaultDurationDays) =>
      setView({ settings: { ...get().project.settings, defaultDurationDays } }),

    undo: () => {
      const { past, future, project } = get();
      const previous = past[past.length - 1];
      if (!previous) return;
      set({ project: previous, past: past.slice(0, -1), future: [project, ...future] });
      scheduleAutosave(previous);
    },

    redo: () => {
      const { past, future, project } = get();
      const next = future[0];
      if (!next) return;
      set({ project: next, past: [...past, project], future: future.slice(1) });
      scheduleAutosave(next);
    },

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,
  };
});

/** The baseline currently being compared against, if any. */
export function selectActiveBaseline(state: ProjectState) {
  return activeBaseline(state.project);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
