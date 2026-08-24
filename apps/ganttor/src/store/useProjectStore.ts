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
  createEmptyProject,
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
  toISO,
  todayDayNum,
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
import { downloadProject } from './persistence.js';
import { readViewPrefs, writeViewPrefs } from './viewPrefs.js';
import {
  backendName,
  deleteProjectById,
  listProjects,
  loadProjectById,
  saveProjectById,
  type ProjectSummary,
} from './projectRepository.js';

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
  /** Row id of the open project. `null` means the next save creates a new row. */
  projectId: string | null;
  /** Every project this account can open, most recently touched first. */
  projects: ProjectSummary[];
  /** Which store is behind the app, so the UI can say where the data went. */
  backend: 'supabase' | 'local';
  unit: ScaleUnit;
  selectedTaskId: string | null;
  selectedDependencyId: string | null;
  theme: 'dark' | 'light';
  notice: Notice | null;
  /** True until the first read settles, so the UI can avoid a flash. */
  loading: boolean;
  lastSavedAt: string | null;

  past: Project[];
  future: Project[];

  // ── Lifecycle ──
  hydrate: () => Promise<void>;
  loadProjectDocument: (project: Project, message?: string) => void;
  resetToDemo: () => void;
  exportFile: () => void;

  // ── Projects ──
  refreshProjects: () => Promise<void>;
  switchProject: (projectId: string) => Promise<void>;
  createNewProject: () => void;
  deleteProject: (projectId: string) => Promise<void>;

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
  /** Move a task to start on a given day, keeping its duration. */
  setTaskStart: (taskId: string, startDay: number) => void;
  /** Replace a task's assignees with one person, or clear them. */
  setAssignee: (taskId: string, resourceId: string | null) => void;

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
/** Everything in flight, so `flushAutosave` can wait for the writes to settle. */
let writeChain: Promise<unknown> = Promise.resolve();
/** The document waiting on the debounce, so it can be written early if needed. */
let pendingProject: Project | null = null;
/**
 * The row id the *open* document will occupy, once something has decided it.
 *
 * The first save of a new project is what mints its id, and until it resolves
 * `state.projectId` is still null. A second debounced write — easily reached by dragging a
 * bar right after an import — would otherwise also read null and insert a *second* row, so
 * it waits on this promise instead. Cleared whenever the open document is replaced, or the
 * next project would inherit the previous one's row.
 */
let openDocumentId: Promise<string | null> | null = null;
/** Assigned by the store factory; lets `flushAutosave` fire the pending write. */
let firePendingSave: (() => void) | null = null;

/**
 * Hand the open document over: write any queued edit to *its* row, then stop tracking it.
 *
 * Called by every action that replaces the open project. Without the write, a debounce
 * still in flight would simply be dropped — `scheduleAutosave` overwrites the queued
 * document — so the last few hundred milliseconds of edits would vanish whenever someone
 * imported a CSV or hit "+ Project" straight after typing.
 *
 * It does not await: `runSave` captures the target row synchronously, so the write is
 * already addressed to the outgoing project before the caller changes `projectId`.
 */
function releaseOpenDocument(): void {
  firePendingSave?.();
  openDocumentId = null;
}

/**
 * Write any queued edit now, and wait for every write to finish.
 *
 * Autosave is debounced by 400ms, which leaves a window where an edit exists only in
 * memory. Signing out inside that window would lose it, so the sign-out path flushes
 * first. Tests use it for the same reason in reverse: to stop a write from landing after
 * the test has finished with the store.
 */
export async function flushAutosave(): Promise<void> {
  firePendingSave?.();
  await writeChain.catch(() => undefined);
}

export const useProjectStore = create<ProjectState>((set, get) => {
  // Read once, at store construction, so zoom and theme survive a reload.
  const storedPrefs = readViewPrefs();

  /**
   * Perform the write.
   *
   * The target row is decided **synchronously**, at the moment the save starts — not
   * inside the promise. Reading `state.projectId` late is a race: opening another project
   * between queueing and writing would send this document into *that* project's row.
   */
  const runSave = (project: Project) => {
    const captured = get().projectId;
    // A known id is immune to whatever happens next. A null one means "not saved yet",
    // and has to wait for any in-flight first save rather than minting a second row.
    const target: Promise<string | null> =
      captured !== null ? Promise.resolve(captured) : (openDocumentId ?? Promise.resolve(null));

    const save = target.then((id) => saveProjectById(id, project));
    // A failed write must not poison the next one: fall back to "no id yet", which makes
    // the retry create the row rather than inherit a rejection.
    openDocumentId = save.catch(() => null);

    writeChain = save
      .then((savedId) => {
        const known = get().projects.find((summary) => summary.id === savedId);
        set({ projectId: savedId, lastSavedAt: new Date().toISOString() });

        // Only re-list when the picker would actually change — a new row, or a rename.
        // Autosave fires on every edit, and a list query per keystroke is a round trip
        // to Postgres for a dropdown whose contents did not move.
        if (known && known.name === project.name) return undefined;
        return listProjects()
          .then((projects) => set({ projects }))
          .catch(() => undefined);
      })
      .catch((error: unknown) => {
        set({
          notice: {
            id: ++noticeCounter,
            tone: 'error',
            message: `Could not autosave: ${describe(error)}`,
          },
        });
      });
  };

  /** Queue an autosave. Debounced so a drag does not write once per frame. */
  const scheduleAutosave = (project: Project) => {
    pendingProject = project;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      const queued = pendingProject;
      pendingProject = null;
      if (queued) runSave(queued);
    }, AUTOSAVE_DELAY_MS);
  };

  firePendingSave = () => {
    if (!autosaveTimer) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    const queued = pendingProject;
    pendingProject = null;
    if (queued) runSave(queued);
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
    projectId: null,
    projects: [],
    backend: backendName(),
    unit: storedPrefs.unit,
    selectedTaskId: null,
    selectedDependencyId: null,
    theme: storedPrefs.theme,
    notice: null,
    loading: true,
    lastSavedAt: null,
    past: [],
    future: [],

    hydrate: async () => {
      releaseOpenDocument();
      try {
        const projects = await listProjects();
        set({ projects });

        // Most recently touched wins: it is where the last session left off.
        const latest = projects[0];
        if (latest) {
          const stored = await loadProjectById(latest.id);
          if (stored) {
            set({
              project: stored.project,
              projectId: latest.id,
              lastSavedAt: stored.savedAt,
              loading: false,
              past: [],
              future: [],
            });
            return;
          }
        }
      } catch (error) {
        set({
          notice: note(
            'warn',
            `Could not read your saved projects (${describe(error)}). Started from the sample instead.`,
          ),
        });
      }
      // Nothing stored yet. The demo stays on screen and the first edit saves it as a
      // new project, so an empty account is never an empty chart.
      set({ loading: false, projectId: null });
    },

    loadProjectDocument: (project, message) => {
      // `projectId: null` is the point: an import or an opened file becomes a *new*
      // project rather than overwriting whichever one happened to be on screen.
      releaseOpenDocument();
      set({
        project,
        projectId: null,
        past: [],
        future: [],
        selectedTaskId: null,
        selectedDependencyId: null,
        ...(message ? { notice: note('success', message) } : {}),
      });
      scheduleAutosave(project);
    },

    resetToDemo: () => {
      releaseOpenDocument();
      const demo = createDemoProject();
      set({
        project: demo,
        projectId: null,
        past: [],
        future: [],
        selectedTaskId: null,
        selectedDependencyId: null,
        notice: note('info', 'Loaded the sample project.'),
      });
      scheduleAutosave(demo);
    },

    refreshProjects: async () => {
      try {
        set({ projects: await listProjects() });
      } catch (error) {
        set({ notice: note('warn', `Could not list your projects: ${describe(error)}`) });
      }
    },

    switchProject: async (projectId) => {
      if (projectId === get().projectId) return;
      // A queued autosave still holds the *outgoing* project, but `runSave` reads
      // `projectId` when it fires. Letting it survive the switch would write the old
      // document into the newly-opened project's row. Flush before moving.
      await flushAutosave();
      releaseOpenDocument();
      set({ loading: true });
      try {
        const stored = await loadProjectById(projectId);
        if (!stored) {
          set({ loading: false, notice: note('warn', 'That project could not be found.') });
          return;
        }
        set({
          project: stored.project,
          projectId,
          lastSavedAt: stored.savedAt,
          loading: false,
          past: [],
          future: [],
          selectedTaskId: null,
          selectedDependencyId: null,
        });
      } catch (error) {
        set({ loading: false, notice: note('error', `Could not open that project: ${describe(error)}`) });
      }
    },

    createNewProject: () => {
      releaseOpenDocument();
      const blank = createEmptyProject({
        id: 'p-new',
        name: 'New project',
        startDate: toISO(todayDayNum()),
      });
      set({
        project: blank,
        projectId: null,
        past: [],
        future: [],
        selectedTaskId: null,
        selectedDependencyId: null,
        notice: note('info', 'Started a new project. Add a task or import a Jira CSV.'),
      });
      scheduleAutosave(blank);
    },

    deleteProject: async (projectId) => {
      // A queued write for this project would recreate the row seconds after deleting it.
      await flushAutosave();
      try {
        await deleteProjectById(projectId);
        const projects = await listProjects();
        set({ projects, notice: note('info', 'Project deleted.') });

        // Deleting the open project has to leave something on screen.
        if (get().projectId === projectId) {
          const next = projects[0];
          if (next) {
            await get().switchProject(next.id);
          } else {
            get().createNewProject();
          }
        }
      } catch (error) {
        set({ notice: note('error', `Could not delete that project: ${describe(error)}`) });
      }
    },

    exportFile: () => {
      downloadProject(get().project);
      set({ notice: note('success', 'Exported the project as a .ganttor.json file.') });
    },

    /*
     * Zoom and theme persist to `localStorage`, not into the document — see
     * `viewPrefs.ts`. Writing them through `setView` would mark the project dirty and
     * fire the autosave on every zoom click.
     */
    setUnit: (unit) => {
      writeViewPrefs({ unit });
      set({ unit });
    },
    setTheme: (theme) => {
      writeViewPrefs({ theme });
      set({ theme });
    },
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

    setTaskStart: (taskId, startDay) => {
      const project = get().project;
      const scheduled = schedule(project).tasks.get(taskId);
      if (!scheduled || scheduled.kind === 'summary') return;
      // Pin the *same span* at the new start rather than editing the end: duration is
      // the independent value, so moving the start must translate the bar, not stretch
      // it. `pinTaskDates` writes the constraint the drag path uses.
      const span = scheduled.end - scheduled.start;
      commit(
        pinTaskDates(project, taskId, {
          start: startDay,
          end: startDay + span,
          durationDays: scheduled.durationDays,
        }),
        null,
      );
    },

    setAssignee: (taskId, resourceId) =>
      commit(updateTaskOp(get().project, taskId, { assigneeIds: resourceId ? [resourceId] : [] })),

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
