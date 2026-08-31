/**
 * The toolbar.
 *
 * Everything here changes what you see or where the project came from. Anything that
 * edits a single task lives in the detail panel instead, so the toolbar stays scannable.
 *
 * ── Why two tiers ───────────────────────────────────────────────────────────────────
 *
 * This was one 56px non-wrapping flex row holding eighteen children — around 1500px of
 * intrinsic width, with no wrap, no overflow and no shrink guards. Below about 1600px the
 * controls on the right were simply cut off, which is why the scale switcher looked
 * missing rather than merely cramped.
 *
 * So: tier 1 is *identity* — which project am I in, is it saved, who am I. Tier 2 is
 * *view* — how am I looking at it. The split is not decoration; it is what lets the
 * project name grow without squeezing a control off the end, because the two no longer
 * compete for the same horizontal budget. Rare and destructive actions go behind `⋯`.
 */

import { SCALE_LABELS, SCALE_UNITS, type ColorBy, type ScaleUnit } from '@ganttor/gantt';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js';
import { useAuthStore } from '../store/useAuthStore.js';
import { flushAutosave, useProjectStore } from '../store/useProjectStore.js';

const COLOR_BY_OPTIONS: { value: ColorBy; label: string }[] = [
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'phase', label: 'Phase' },
];

export interface ToolbarProps {
  onImport: () => void;
  onSettings: () => void;
  panel: 'task' | 'workload' | 'baselines';
  onPanelChange: (panel: 'task' | 'workload' | 'baselines') => void;
  /** Scroll the chart back to today. Needed once the axis grows without bound. */
  onToday: () => void;
}

export function Toolbar({ onImport, onSettings, panel, onPanelChange, onToday }: ToolbarProps) {
  const project = useProjectStore((s) => s.project);
  const unit = useProjectStore((s) => s.unit);
  const theme = useProjectStore((s) => s.theme);
  const lastSavedAt = useProjectStore((s) => s.lastSavedAt);

  const setUnit = useProjectStore((s) => s.setUnit);
  const setTheme = useProjectStore((s) => s.setTheme);
  const setColorBy = useProjectStore((s) => s.setColorBy);
  const renameProject = useProjectStore((s) => s.renameProject);
  const toggleCriticalPath = useProjectStore((s) => s.toggleCriticalPath);
  const toggleLock = useProjectStore((s) => s.toggleLock);
  const addTask = useProjectStore((s) => s.addTask);
  const exportFile = useProjectStore((s) => s.exportFile);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const past = useProjectStore((s) => s.past.length);
  const future = useProjectStore((s) => s.future.length);

  const projects = useProjectStore((s) => s.projects);
  const projectId = useProjectStore((s) => s.projectId);
  const backend = useProjectStore((s) => s.backend);
  const switchProject = useProjectStore((s) => s.switchProject);
  const createNewProject = useProjectStore((s) => s.createNewProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const refreshProjects = useProjectStore((s) => s.refreshProjects);
  const reloadOpenProject = useProjectStore((s) => s.reloadOpenProject);

  const authEmail = useAuthStore((s) => s.email);
  const signOut = useAuthStore((s) => s.signOut);

  const { locked, showCriticalPath, colorBy } = project.settings;

  return (
    <header className="ganttor-bar">
      {/* ── Tier 1: identity ──────────────────────────────────────────────────────── */}
      <div className="ganttor-bar__tier">
        <div className="ganttor-brand">
          <span className="ganttor-brand__mark">Ganttor</span>
          <span className="ganttor-brand__meta">
            {savedLabel(lastSavedAt)}
            {backend === 'local' && ' · this browser only'}
          </span>
        </div>

        {/*
         * The one control that genuinely wants the leftover room. It used to be capped
         * at 28ch inside an overflowing row, so a real project name was truncated while
         * empty space sat further along the bar.
         */}
        <input
          className="ganttor-bar__title"
          value={project.name}
          aria-label="Project name"
          onChange={(event) => renameProject(event.target.value)}
        />

        <div className="ganttor-picker">
          <select
            className="ganttor-select ganttor-picker__select"
            aria-label="Open project"
            // An unsaved project has no row yet, so it is not in the list — show the
            // placeholder rather than silently displaying some other project's name.
            value={projectId ?? ''}
            onChange={(event) => {
              if (event.target.value) void switchProject(event.target.value);
            }}
          >
            {!projectId && <option value="">Unsaved project</option>}
            {projects.map((summary) => (
              <option key={summary.id} value={summary.id}>
                {summary.name}
              </option>
            ))}
          </select>

          {/*
            * The workspace is shared, so "is this list current" is an identity question —
            * which is why it sits in tier 1 next to the picker rather than behind `⋯`.
            */}
          <button
            type="button"
            className="ganttor-btn ganttor-btn--ghost"
            aria-label="Refresh the project list"
            title="Re-read the project list from the server"
            onClick={() => void refreshProjects()}
          >
            Refresh
          </button>

          <button
            type="button"
            className="ganttor-btn ganttor-btn--ghost"
            onClick={createNewProject}
            title="Start a new, empty project"
          >
            + Project
          </button>
        </div>

        {authEmail && (
          <button
            type="button"
            className="ganttor-btn ganttor-btn--ghost"
            // Autosave is debounced, so an edit made in the last moment exists only in
            // memory. Write it before dropping the session that authorises the write.
            onClick={() => void flushAutosave().then(signOut)}
            title={`Signed in as ${authEmail}`}
          >
            Sign out
          </button>
        )}
      </div>

      {/* ── Tier 2: view ──────────────────────────────────────────────────────────── */}
      <div className="ganttor-bar__tier ganttor-bar__tier--view">
        {/*
         * Native buttons with `aria-pressed`, deliberately. A Radix ToggleGroup would
         * relabel these `role="radio"` and break the zoom tests, which query by button
         * role — for no accessibility gain over what is already here.
         */}
        <div className="ganttor-seg" role="group" aria-label="Time scale">
          {SCALE_UNITS.map((value: ScaleUnit) => (
            <button
              key={value}
              type="button"
              className="ganttor-seg__item"
              aria-pressed={unit === value}
              onClick={() => setUnit(value)}
            >
              {SCALE_LABELS[value]}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="ganttor-btn ganttor-btn--ghost"
          onClick={onToday}
          title="Scroll back to today"
        >
          Today
        </button>

        <label className="ganttor-row">
          <span className="ganttor-field__label">Colour</span>
          <select
            className="ganttor-select"
            value={colorBy}
            aria-label="Colour bars by"
            onChange={(event) => setColorBy(event.target.value as ColorBy)}
          >
            {COLOR_BY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="ganttor-btn"
          aria-pressed={showCriticalPath}
          onClick={toggleCriticalPath}
          title="Highlight the chain of zero-float tasks that sets the project finish"
        >
          Critical path
        </button>

        <span className="ganttor-bar__spacer" />

        <div className="ganttor-seg" role="group" aria-label="Side panel">
          {(['task', 'workload', 'baselines'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="ganttor-seg__item"
              aria-pressed={panel === value}
              onClick={() => onPanelChange(value)}
            >
              {value === 'task' ? 'Details' : value === 'workload' ? 'Workload' : 'Baselines'}
            </button>
          ))}
        </div>

        <button type="button" className="ganttor-btn" onClick={() => addTask()} disabled={locked}>
          + Task
        </button>

        {/*
         * Lock stays visible rather than moving into the overflow menu. It is a *mode*
         * the whole surface behaves differently under, so hiding it would make "why can
         * I not edit anything" a two-click question.
         */}
        <button
          type="button"
          className="ganttor-btn"
          aria-pressed={locked}
          onClick={toggleLock}
          title={locked ? 'Editing is disabled' : 'Disable editing'}
        >
          {locked ? 'View only' : 'Editable'}
        </button>

        <button type="button" className="ganttor-btn ganttor-btn--primary" onClick={onImport}>
          Import Jira CSV
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="ganttor-btn ganttor-btn--ghost"
              aria-label="More actions"
              title="More actions"
            >
              ⋯
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Edit</DropdownMenuLabel>
            <DropdownMenuItem disabled={past === 0} onSelect={() => undo()}>
              Undo
              <DropdownMenuShortcut>⌘Z</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={future === 0} onSelect={() => redo()}>
              Redo
              <DropdownMenuShortcut>⇧⌘Z</DropdownMenuShortcut>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuLabel>Project</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => exportFile()}>Export as JSON…</DropdownMenuItem>
            <DropdownMenuItem
              disabled={!projectId}
              onSelect={() => {
                if (!projectId) return;
                // Behind a confirm like Delete: it throws away unsaved local edits and
                // the undo stack along with them.
                const ok = window.confirm(
                  'Reload “' + project.name + '” from the server? Unsaved changes will be lost.',
                );
                if (ok) void reloadOpenProject();
              }}
            >
              Reload from server…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSettings()}>Settings…</DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? 'Light theme' : 'Dark theme'}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem
              variant="destructive"
              disabled={!projectId}
              onSelect={() => {
                if (!projectId) return;
                // Deleting a project is not undoable — the undo stack is per-document.
                const ok = window.confirm(`Delete “${project.name}”? This cannot be undone.`);
                if (ok) void deleteProject(projectId);
              }}
            >
              Delete project…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function savedLabel(iso: string | null): string {
  if (!iso) return 'not saved yet';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'not saved yet';
  return `saved ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
