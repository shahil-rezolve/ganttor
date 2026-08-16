/**
 * The toolbar.
 *
 * Everything here changes what you see or where the project came from. Anything that
 * edits a single task lives in the detail panel instead, so the toolbar stays scannable.
 */

import { SCALE_LABELS, SCALE_UNITS, type ColorBy, type ScaleUnit } from '@ganttor/gantt';

import { useProjectStore } from '../store/useProjectStore.js';

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
}

export function Toolbar({ onImport, onSettings, panel, onPanelChange }: ToolbarProps) {
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

  const { locked, showCriticalPath, colorBy } = project.settings;

  return (
    <div className="ganttor-bar">
      <div className="ganttor-brand">
        <span className="ganttor-brand__mark">Ganttor</span>
        <span className="ganttor-brand__meta">{savedLabel(lastSavedAt)}</span>
      </div>

      <input
        className="ganttor-bar__title"
        value={project.name}
        aria-label="Project name"
        onChange={(event) => renameProject(event.target.value)}
      />

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

      <button
        type="button"
        className="ganttor-btn ganttor-btn--ghost"
        onClick={undo}
        disabled={past === 0}
        title="Undo (⌘Z)"
        aria-label="Undo"
      >
        ↶
      </button>
      <button
        type="button"
        className="ganttor-btn ganttor-btn--ghost"
        onClick={redo}
        disabled={future === 0}
        title="Redo (⇧⌘Z)"
        aria-label="Redo"
      >
        ↷
      </button>

      <button type="button" className="ganttor-btn" onClick={() => addTask()} disabled={locked}>
        + Task
      </button>

      <button
        type="button"
        className="ganttor-btn"
        aria-pressed={locked}
        onClick={toggleLock}
        title={locked ? 'Editing is disabled' : 'Disable editing'}
      >
        {locked ? 'View only' : 'Editable'}
      </button>

      <button
        type="button"
        className="ganttor-btn ganttor-btn--ghost"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      >
        {theme === 'dark' ? '◐' : '◑'}
      </button>

      <button type="button" className="ganttor-btn ganttor-btn--ghost" onClick={onSettings}>
        Settings
      </button>
      <button type="button" className="ganttor-btn" onClick={exportFile}>
        Export
      </button>
      <button type="button" className="ganttor-btn ganttor-btn--primary" onClick={onImport}>
        Import Jira CSV
      </button>
    </div>
  );
}

function savedLabel(iso: string | null): string {
  if (!iso) return 'not saved yet';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'not saved yet';
  return `saved ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
