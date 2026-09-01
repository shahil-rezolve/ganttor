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
 *
 * The workspace is shared, so autosave is also *guarded*. Every write carries the
 * `updated_at` it last read, and a write refused because the row moved sets
 * `remoteConflict`, which halts autosave rather than clobbering a teammate. Nothing is
 * merged — this detects and refuses; Export as JSON is the way out.
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
  /** Every project in the shared workspace, most recently touched first. */
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
  /**
   * The server's `updated_at` for the open row — the token every guarded save carries.
   * Never a client clock: see `saveProjectById`.
   */
  lastSavedAt: string | null;
  /**
   * A save was refused because the row moved underneath us. Autosave is halted until the
   * document is replaced; the edits stay on screen and Export as JSON is the way out.
   */
  remoteConflict: boolean;

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
  /** Re-read the open project from the server, discarding unsaved local edits. */
  reloadOpenProject: () => Promise<void>;
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
/** Where the *open* document lives, and the concurrency token for writing to it. */
interface OpenRef {
  id: string | null;
  savedAt: string | null;
}
/**
 * What the next save of the open document should address, once something has decided it.
 *
 * Two problems, one queue. The first save of a new project is what mints its id, and until
 * it resolves `state.projectId` is still null — a second debounced write (easily reached by
 * dragging a bar right after an import) would read null too and insert a *second* row. And
 * a write is also what *moves* `updated_at`, so a save with a known id can no longer skip
 * the queue either: it would carry the token it read before the in-flight write landed and
 * be refused as a phantom conflict. Both wait on this promise instead.
 *
 * Cleared whenever the open document is replaced, or the next project would inherit the
 * previous one's row.
 */
let openDocumentRef: Promise<OpenRef> | null = null;
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
  openDocumentRef = null;
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

  const note = (tone: NoticeTone, message: string, highlight?: string[]): Notice => ({
    id: ++noticeCounter,
    tone,
    message,
    ...(highlight ? { highlight } : {}),
  });

  /**
   * Perform the write.
   *
   * The target row *and its token* are decided **synchronously**, at the moment the save
   * starts — not inside the promise. Reading `state.projectId` late is a race: opening
   * another project between queueing and writing would send this document into *that*
   * project's row. Reading `state.lastSavedAt` late is the same race one level down.
   */
  const runSave = (project: Project) => {
    // A spent token can only fail, once per keystroke. See `remoteConflict`.
    if (get().remoteConflict) return;

    const captured: OpenRef = { id: get().projectId, savedAt: get().lastSavedAt };
    // Always queue behind whatever is in flight — that write is what moves `updated_at`,
    // so even a known id has to wait for the token its successor will need.
    const target: Promise<OpenRef> = openDocumentRef ?? Promise.resolve(captured);

    const save = target.then((ref) => saveProjectById(ref.id, project, ref.savedAt));
    // Only a write that actually landed moves the ref. A refused or failed one did not
    // touch `updated_at`, so the ref we started from is still live — where the old code
    // fell back to "no id yet" and minted a duplicate row.
    openDocumentRef = save
      .then((outcome) =>
        outcome.kind === 'saved' ? { id: outcome.id, savedAt: outcome.savedAt } : captured,
      )
      .catch(() => captured);

    writeChain = save
      .then((outcome) => {
        if (outcome.kind === 'conflict') {
          set({
            remoteConflict: true,
            notice: note(
              'error',
              'Someone else saved this project while you had it open. Your last change was ' +
                'not saved. Use ⋯ → Export as JSON to keep it, then ⋯ → Reload from server.',
            ),
          });
          return undefined;
        }
        if (outcome.kind === 'gone') {
          set({
            remoteConflict: true,
            notice: note(
              'error',
              'Someone else deleted this project. Your changes were not saved — use ' +
                '⋯ → Export as JSON to keep them.',
            ),
          });
          return undefined;
        }

        const known = get().projects.find((summary) => summary.id === outcome.id);
        // The *server's* timestamp, not `new Date()`. It is the token the next save has
        // to present, and a client clock would be rejected by the row it claims to know.
        set({ projectId: outcome.id, lastSavedAt: outcome.savedAt });
        writeViewPrefs({ lastProjectId: outcome.id });

        // Only re-list when the picker would actually change — a new row, or a rename.
        // Autosave fires on every edit, and a list query per keystroke is a round trip
        // to Postgres for a dropdown whose contents did not move.
        if (known && known.name === project.name) return undefined;
        return listProjects()
          .then((projects) => set({ projects }))
          .catch(() => undefined);
      })
      .catch((error: unknown) => {
        set({ notice: note('error', `Could not autosave: ${describe(error)}`) });
      });
  };

  /** Queue an autosave. Debounced so a drag does not write once per frame. */
  const scheduleAutosave = (project: Project) => {
    // Halted after a conflict: retrying with a spent token fails forever and emits a
    // notice per keystroke, while resuming would quietly go back to last-write-wins.
    if (get().remoteConflict) return;
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

  /** Names a task for a message: the Jira key if it has one, else its summary. */
  const label = (taskId: string): string => {
    const task = get().project.tasks.find((t) => t.id === taskId);
    return task?.jiraKey ?? task?.name ?? taskId;
  };

  /**
   * Install a stored project as the open document.
   *
   * Shared by `switchProject` and `reloadOpenProject`, which differ only in whether the id
   * is allowed to be the one already open — `switchProject` early-returns on a match, so
   * without this split a reload would be a no-op.
   */
  const openProject = async (projectId: string): Promise<void> => {
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
      // Remembered per browser, so a reload reopens this rather than whichever project
      // the team touched most recently.
      writeViewPrefs({ lastProjectId: projectId });
      set({
        project: stored.project,
        projectId,
        lastSavedAt: stored.savedAt,
        remoteConflict: false,
        loading: false,
        past: [],
        future: [],
        selectedTaskId: null,
        selectedDependencyId: null,
      });
    } catch (error) {
      set({ loading: false, notice: note('error', `Could not open that project: ${describe(error)}`) });
    }
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
    remoteConflict: false,
    past: [],
    future: [],

    hydrate: async () => {
      releaseOpenDocument();
      set({ remoteConflict: false });
      try {
        const projects = await listProjects();
        set({ projects });

        // Whatever *this browser* last had open. The workspace is shared, so "most
        // recently touched" now means whatever anyone edited last — falling back to it is
        // right for a first visit and wrong as a default, or signing in would drop you
        // into a colleague's project.
        const remembered = readViewPrefs().lastProjectId;
        const latest = projects.find((summary) => summary.id === remembered) ?? projects[0];
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
      // new project, so an empty workspace is never an empty chart.
      set({ loading: false, projectId: null, lastSavedAt: null });
    },

    loadProjectDocument: (project, message) => {
      // `projectId: null` is the point: an import or an opened file becomes a *new*
      // project rather than overwriting whichever one happened to be on screen.
      releaseOpenDocument();
      set({
        project,
        projectId: null,
        // The token belongs to the document being replaced. Carrying it into a new one
        // would hand the next save a precondition from a different row entirely.
        lastSavedAt: null,
        remoteConflict: false,
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
        lastSavedAt: null,
        remoteConflict: false,
        past: [],
        future: [],
        selectedTaskId: null,
        selectedDependencyId: null,
        notice: note('info', 'Loaded the sample project.'),
      });
      scheduleAutosave(demo);
    },

    refreshProjects: async () => {
      // Settle our own writes first, or a refresh landing mid-save would read an
      // `updated_at` we are about to be told about and report it as someone else's edit.
      await flushAutosave();
      try {
        const projects = await listProjects();
        set({ projects });

        // The common case is not a new project appearing but the *open* one moving under
        // you. Never auto-reload on it: that would discard local edits and reset the undo
        // stack without being asked.
        const { projectId, lastSavedAt, remoteConflict } = get();
        const open = projectId ? projects.find((summary) => summary.id === projectId) : undefined;
        if (open && lastSavedAt && open.updatedAt !== lastSavedAt && !remoteConflict) {
          set({
            notice: note(
              'info',
              'Someone else has saved changes to this project. Use ⋯ → Reload from server ' +
                'to see them — your unsaved edits would be discarded.',
            ),
          });
        }
      } catch (error) {
        set({ notice: note('warn', `Could not list the projects: ${describe(error)}`) });
      }
    },

    switchProject: async (projectId) => {
      if (projectId === get().projectId) return;
      await openProject(projectId);
    },

    reloadOpenProject: async () => {
      const projectId = get().projectId;
      if (!projectId) return;
      await openProject(projectId);
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
        lastSavedAt: null,
        remoteConflict: false,
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
