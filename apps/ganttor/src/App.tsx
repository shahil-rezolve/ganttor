/**
 * The app shell.
 *
 * Holds only what is genuinely local — which dialog is open, which side panel is showing
 * — and reads everything else from the store. The `GanttView` handed up by the chart is
 * kept here so the panels render from the *same* schedule the bars were drawn from,
 * rather than each recomputing it.
 */

import { useCallback, useEffect, useState } from 'react';

import { GanttChart, Legend, type GanttView } from '@ganttor/gantt';

import { useProjectStore } from './store/useProjectStore.js';
import { BaselinePanel } from './ui/BaselinePanel.js';
import { ImportDialog } from './ui/ImportDialog.js';
import { SettingsDialog } from './ui/SettingsDialog.js';
import { TaskPanel } from './ui/TaskPanel.js';
import { Toolbar } from './ui/Toolbar.js';
import { WorkloadPanel } from './ui/WorkloadPanel.js';

type Panel = 'task' | 'workload' | 'baselines';

export function App() {
  const project = useProjectStore((s) => s.project);
  const unit = useProjectStore((s) => s.unit);
  const theme = useProjectStore((s) => s.theme);
  const notice = useProjectStore((s) => s.notice);
  const loading = useProjectStore((s) => s.loading);
  const selectedTaskId = useProjectStore((s) => s.selectedTaskId);
  const selectedDependencyId = useProjectStore((s) => s.selectedDependencyId);

  const hydrate = useProjectStore((s) => s.hydrate);
  const selectTask = useProjectStore((s) => s.selectTask);
  const selectDependency = useProjectStore((s) => s.selectDependency);
  const toggleCollapse = useProjectStore((s) => s.toggleCollapse);
  const applyDates = useProjectStore((s) => s.applyDates);
  const createLink = useProjectStore((s) => s.createLink);
  const dismissNotice = useProjectStore((s) => s.dismissNotice);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const nudgeTask = useProjectStore((s) => s.nudgeTask);
  const removeTask = useProjectStore((s) => s.removeTask);

  const [panel, setPanel] = useState<Panel>('task');
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<GanttView | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Selecting a task should show its details, or the panel choice feels ignored.
  useEffect(() => {
    if (selectedTaskId) setPanel('task');
  }, [selectedTaskId]);

  const handleView = useCallback((next: GanttView) => setView(next), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal keys from a field the user is typing in.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (project.settings.locked || !selectedTaskId) return;

      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        nudgeTask(selectedTaskId, event.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        removeTask(selectedTaskId);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo, nudgeTask, removeTask, selectedTaskId, project.settings.locked]);

  return (
    <div className="ganttor gantt" data-gantt-theme={theme}>
      <Toolbar
        onImport={() => setImportOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        panel={panel}
        onPanelChange={setPanel}
      />

      {notice && (
        <div className="ganttor-notice" data-tone={notice.tone} role="status">
          <span className="ganttor-notice__message">{notice.message}</span>
          <button type="button" className="ganttor-btn ganttor-btn--ghost" onClick={dismissNotice}>
            Dismiss
          </button>
        </div>
      )}

      {view && view.result.cycles.length > 0 && (
        <div className="ganttor-notice" data-tone="error" role="alert">
          <span className="ganttor-notice__message">
            {view.result.cycles.length} circular dependency
            {view.result.cycles.length === 1 ? '' : 'ies'} in this project:{' '}
            {view.result.cycles
              .map((cycle) => cycle.map((id) => labelOf(project, id)).join(' → '))
              .join('; ')}
            . The looping links are drawn dashed and were left out of the schedule.
          </span>
        </div>
      )}

      <div className="ganttor-main">
        <div className="ganttor-chart">
          {loading ? (
            <div className="ganttor-empty">Opening the last project…</div>
          ) : (
            <GanttChart
              project={project}
              unit={unit}
              theme={theme}
              selectedTaskId={selectedTaskId}
              selectedDependencyId={selectedDependencyId}
              onSelectTask={selectTask}
              onSelectDependency={selectDependency}
              onToggleCollapse={toggleCollapse}
              onChangeDates={applyDates}
              onCreateLink={createLink}
              onView={handleView}
            />
          )}
        </div>

        {panel === 'task' && <TaskPanel view={view} />}
        {panel === 'workload' && <WorkloadPanel view={view} />}
        {panel === 'baselines' && <BaselinePanel view={view} />}
      </div>

      {view && (
        <Legend colors={view.colors} showCriticalPath={project.settings.showCriticalPath} />
      )}

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function labelOf(
  project: { tasks: { id: string; name: string; jiraKey?: string }[] },
  id: string,
): string {
  const task = project.tasks.find((t) => t.id === id);
  return task?.jiraKey ?? task?.name ?? id;
}
