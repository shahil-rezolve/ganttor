/**
 * The app shell.
 *
 * Holds only what is genuinely local — which dialog is open, which side panel is showing
 * — and reads everything else from the store. The `GanttView` handed up by the chart is
 * kept here so the panels render from the *same* schedule the bars were drawn from,
 * rather than each recomputing it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  GanttChart,
  Legend,
  type GanttView,
  type TaskGridAction,
  type TaskGridEdit,
} from '@ganttor/gantt';

import { OVERLAY_HOST_ID } from './lib/portal.js';
import { useAuthStore } from './store/useAuthStore.js';
import { useProjectStore } from './store/useProjectStore.js';
import {
  clamp,
  PANEL_MAX,
  PANEL_MIN,
  readViewPrefs,
  writeViewPrefs,
} from './store/viewPrefs.js';
import { BaselinePanel } from './ui/BaselinePanel.js';
import { ImportDialog } from './ui/ImportDialog.js';
import { LoginPage } from './ui/LoginPage.js';
import { SettingsDialog } from './ui/SettingsDialog.js';
import { TaskPanel } from './ui/TaskPanel.js';
import { Toolbar } from './ui/Toolbar.js';
import { WorkloadPanel } from './ui/WorkloadPanel.js';

type Panel = 'task' | 'workload' | 'baselines';

/**
 * The auth gate.
 *
 * Split from `Workspace` so the app's effects — hydrate, the key handler — never run for
 * a signed-out visitor. Mounting the workspace behind a conditional render rather than
 * hiding it means no project request is issued without a session to authorise it.
 */
export function App() {
  const status = useAuthStore((s) => s.status);
  const initialize = useAuthStore((s) => s.initialize);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  if (status === 'loading') {
    return (
      <div className="ganttor-login" data-gantt-theme="dark">
        <span className="ganttor-login__sub">Checking your session…</span>
      </div>
    );
  }

  if (status === 'signed-out') return <LoginPage />;

  return <Workspace />;
}

function Workspace() {
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
  const updateTask = useProjectStore((s) => s.updateTask);
  const setTaskStart = useProjectStore((s) => s.setTaskStart);
  const setAssignee = useProjectStore((s) => s.setAssignee);
  const addTask = useProjectStore((s) => s.addTask);
  const indentTask = useProjectStore((s) => s.indentTask);
  const outdentTask = useProjectStore((s) => s.outdentTask);

  const [panel, setPanel] = useState<Panel>('task');
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<GanttView | null>(null);

  /*
   * ── Layout, remembered per browser ──────────────────────────────────────────────
   * Read once on mount. `nameColumnWidth` stays `null` until the splitter is dragged,
   * which is what lets the chart auto-fit the column to the longest visible name; the
   * moment the user expresses a preference, it wins.
   */
  const [nameColumnWidth, setNameColumnWidth] = useState<number | null>(
    () => readViewPrefs().nameColumnWidth,
  );
  const [panelWidth, setPanelWidth] = useState<number>(() => readViewPrefs().panelWidth);
  const [todayToken, setTodayToken] = useState(0);

  const handleNameColumnWidthChange = useCallback((px: number) => {
    setNameColumnWidth(px);
    writeViewPrefs({ nameColumnWidth: px });
  }, []);

  const showToday = useCallback(() => setTodayToken((token) => token + 1), []);

  /* The detail-panel splitter. Same pointer-capture shape as the chart's own. */
  const panelGesture = useRef<{ startX: number; startWidth: number } | null>(null);
  const [panelDragging, setPanelDragging] = useState(false);

  const onPanelSplitDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      panelGesture.current = { startX: event.clientX, startWidth: panelWidth };
      setPanelDragging(true);
    },
    [panelWidth],
  );

  const onPanelSplitMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = panelGesture.current;
    if (!gesture) return;
    // The panel is on the right, so dragging left must widen it.
    setPanelWidth(
      clamp(gesture.startWidth - (event.clientX - gesture.startX), PANEL_MIN, PANEL_MAX),
    );
  }, []);

  const onPanelSplitUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!panelGesture.current) return;
    panelGesture.current = null;
    setPanelDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // Persist on release, not per pointer move — one write per gesture.
    setPanelWidth((width) => {
      writeViewPrefs({ panelWidth: width });
      return width;
    });
  }, []);

  const onPanelSplitKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = (event.shiftKey ? 40 : 12) * (event.key === 'ArrowLeft' ? 1 : -1);
    setPanelWidth((width) => {
      const next = clamp(width + step, PANEL_MIN, PANEL_MAX);
      writeViewPrefs({ panelWidth: next });
      return next;
    });
  }, []);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Selecting a task should show its details, or the panel choice feels ignored.
  useEffect(() => {
    if (selectedTaskId) setPanel('task');
  }, [selectedTaskId]);

  const handleView = useCallback((next: GanttView) => setView(next), []);

  /**
   * Grid edits, mapped onto project mutations.
   *
   * The grid deliberately does not know that a start date is a constraint rather than a
   * stored field — that translation happens here, so the chart component stays usable
   * against any host.
   */
  const handleEditTask = useCallback(
    (taskId: string, edit: TaskGridEdit) => {
      switch (edit.field) {
        case 'name':
          updateTask(taskId, { name: edit.value });
          return;
        case 'durationDays':
          updateTask(taskId, { durationDays: edit.value });
          return;
        case 'percentComplete':
          updateTask(taskId, { percentComplete: edit.value });
          return;
        case 'start':
          setTaskStart(taskId, edit.value);
          return;
        case 'assignee':
          setAssignee(taskId, edit.value);
      }
    },
    [updateTask, setTaskStart, setAssignee],
  );

  const handleRowAction = useCallback(
    (taskId: string, action: TaskGridAction) => {
      switch (action) {
        case 'add':
          addTask(taskId);
          return;
        case 'delete':
          removeTask(taskId);
          return;
        case 'indent':
          indentTask(taskId);
          return;
        case 'outdent':
          outdentTask(taskId);
      }
    },
    [addTask, removeTask, indentTask, outdentTask],
  );

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
        onToday={showToday}
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
              growAxis
              scrollToTodayToken={todayToken}
              {...(nameColumnWidth !== null ? { nameColumnWidth } : {})}
              onNameColumnWidthChange={handleNameColumnWidthChange}
              selectedTaskId={selectedTaskId}
              selectedDependencyId={selectedDependencyId}
              onSelectTask={selectTask}
              onSelectDependency={selectDependency}
              onToggleCollapse={toggleCollapse}
              onChangeDates={applyDates}
              onCreateLink={createLink}
              onEditTask={handleEditTask}
              onRowAction={handleRowAction}
              onView={handleView}
            />
          )}
        </div>

        <div
          className="ganttor-split"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the detail panel"
          aria-valuenow={Math.round(panelWidth)}
          tabIndex={0}
          data-dragging={panelDragging || undefined}
          onPointerDown={onPanelSplitDown}
          onPointerMove={onPanelSplitMove}
          onPointerUp={onPanelSplitUp}
          onPointerCancel={onPanelSplitUp}
          onKeyDown={onPanelSplitKeyDown}
        />

        {/*
         * The width lives on a wrapper so `.ganttor-panel` stays the element that holds
         * the panel's content — two tests reach for it by class name.
         */}
        <div className="ganttor-panelhost" style={{ width: panelWidth }}>
          {panel === 'task' && <TaskPanel view={view} />}
          {panel === 'workload' && <WorkloadPanel view={view} />}
          {panel === 'baselines' && <BaselinePanel view={view} />}
        </div>
      </div>

      {view && (
        <Legend colors={view.colors} showCriticalPath={project.settings.showCriticalPath} />
      )}

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/*
       * Portalled overlays mount here rather than on `document.body`, so they stay
       * inside the `--gantt-*` token scope. Empty, so it contributes no layout.
       */}
      <div id={OVERLAY_HOST_ID} />
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
