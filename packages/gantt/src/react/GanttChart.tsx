/**
 * The chart.
 *
 * Layers, back to front: non-working shading and grid columns → row bands → today line
 * → baseline ghost bars → bars, summary brackets, and milestone diamonds → dependency
 * arrows → labels. That order is what lets an arrow cross a bar without disappearing
 * under it and a today line sit behind the bars rather than across them.
 *
 * The component owns no project state. It renders what `useGanttView` derives and
 * reports gestures upward, so the same chart works against a zustand store, a reducer,
 * or a static fixture in a test.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { todayDayNum, type DayNum } from '../core/day.js';
import type { TaskDates } from '../core/duration.js';
import type { ScaleUnit } from '../core/timescale.js';
import type { Project } from '../core/types.js';
import { DependencyLayer } from './DependencyLayer.js';
import { estimateTextWidth, labelLayout, type RowMetrics } from './geometry.js';
import { CATEGORICAL, categoricalIndex } from './palette.js';
import { TaskGrid, type TaskGridAction, type TaskGridEdit } from './TaskGrid.js';
import { TimelineHeader } from './TimelineHeader.js';
import { useBarDrag } from './useBarDrag.js';
import { todayX, useGanttView, type GanttRow, type GanttView } from './useGanttView.js';

/** Matches `.gantt__summary-bar`'s height in gantt.css, which centres it in its row. */
const SUMMARY_BAR_HEIGHT = 11;

export interface GanttChartProps {
  project: Project;
  unit: ScaleUnit;
  selectedTaskId?: string | null;
  selectedDependencyId?: string | null;
  /** Overridden in tests so a snapshot does not depend on the day it runs. */
  today?: DayNum;
  theme?: 'light' | 'dark';
  metrics?: RowMetrics;
  nameColumnWidth?: number;
  onSelectTask?: (taskId: string) => void;
  onSelectDependency?: (dependencyId: string) => void;
  onToggleCollapse?: (taskId: string) => void;
  /** A bar was moved or resized. Persist by pinning the task's dates. */
  onChangeDates?: (taskId: string, dates: TaskDates) => void;
  /** A link was dragged from one bar to another. Validate before accepting. */
  onCreateLink?: (predecessorId: string, successorId: string) => void;
  /**
   * A cell in the task grid was edited. Supplying this turns the grid's cells into
   * inputs; a locked project suppresses them regardless.
   */
  onEditTask?: (taskId: string, edit: TaskGridEdit) => void;
  /** Add / delete / indent / outdent from a grid row's controls. */
  onRowAction?: (taskId: string, action: TaskGridAction) => void;
  /** Exposes the derived view so a host can render panels from the same schedule. */
  onView?: (view: GanttView) => void;
}

export function GanttChart({
  project,
  unit,
  selectedTaskId = null,
  selectedDependencyId = null,
  today,
  theme,
  metrics,
  nameColumnWidth = 300,
  onSelectTask,
  onSelectDependency,
  onToggleCollapse,
  onChangeDates,
  onCreateLink,
  onEditTask,
  onRowAction,
  onView,
}: GanttChartProps) {
  const view = useGanttView({ project, unit, ...(metrics ? { metrics } : {}) });
  const { scale, rows, arrows, calendar, canvasHeight, resourceNames } = view;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ scrollLeft: 0, width: 1200 });

  useLayoutEffect(() => {
    onView?.(view);
  }, [view, onView]);

  // Label placement depends on where the viewport is, so it needs measuring — but only
  // to decide inside/after/before, never to compute bar geometry.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const measure = () => {
      const next = {
        scrollLeft: element.scrollLeft,
        width: element.clientWidth - nameColumnWidth - 386,
      };
      // Compare values, not object identity: scroll fires far more often than the
      // measurement actually changes, and each new object would re-render the chart.
      setViewport((current) =>
        current.scrollLeft === next.scrollLeft && current.width === next.width ? current : next,
      );
    };

    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [nameColumnWidth]);

  const locked = project.settings.locked;

  const handleCommitDates = useCallback(
    (taskId: string, dates: TaskDates) => onChangeDates?.(taskId, dates),
    [onChangeDates],
  );
  const handleCommitLink = useCallback(
    (predecessorId: string, successorId: string) => onCreateLink?.(predecessorId, successorId),
    [onCreateLink],
  );

  const drag = useBarDrag({
    scale,
    calendar,
    locked: locked || !onChangeDates,
    onCommitDates: handleCommitDates,
    onCommitLink: handleCommitLink,
  });

  const resourceIds = useMemo(() => project.resources.map((r) => r.id).sort(), [project.resources]);
  const resourceColorOf = useCallback(
    (id: string) => CATEGORICAL[categoricalIndex(id, resourceIds)]!,
    [resourceIds],
  );

  const todayDay = today ?? todayDayNum();
  const todayOffset = todayX(scale, todayDay);
  const showCritical = project.settings.showCriticalPath;

  const draftLine = useMemo(() => {
    const preview = drag.preview;
    if (!preview || preview.mode !== 'link' || !preview.cursor) return null;
    const source = view.rowByTaskId.get(preview.taskId);
    const box = source?.bar ?? source?.diamond;
    if (!box) return null;
    const x1 = 'cx' in box ? box.cx : box.x + box.width;
    const y1 = 'cy' in box ? box.cy : box.centerY;
    return { x1, y1, x2: preview.cursor.x, y2: preview.cursor.y };
  }, [drag.preview, view.rowByTaskId]);

  if (rows.length === 0) {
    return (
      <div className="gantt" data-gantt-theme={theme}>
        <div className="gantt__empty">No tasks yet — import a Jira CSV to get started.</div>
      </div>
    );
  }

  return (
    <div className="gantt" data-gantt-theme={theme}>
      <div className="gantt__scroll" ref={scrollRef}>
        <div className="gantt__layout">
          <TaskGrid
            rows={rows}
            resourceNames={resourceNames}
            resourceColorOf={resourceColorOf}
            selectedId={selectedTaskId}
            nameColumnWidth={nameColumnWidth}
            onSelect={(id) => onSelectTask?.(id)}
            onToggleCollapse={(id) => onToggleCollapse?.(id)}
            editable={!locked}
            resources={project.resources}
            {...(onEditTask ? { onEditTask } : {})}
            {...(onRowAction ? { onRowAction } : {})}
          />

          <div className="gantt__timeline">
            <TimelineHeader scale={scale} calendar={calendar} />

            <div
              className="gantt__canvas"
              style={{ width: scale.totalWidth, height: canvasHeight }}
            >
              {/* Non-working shading and vertical grid. */}
              {scale.dayColumns().map((column) => (
                <div
                  key={column.day}
                  className="gantt__col"
                  style={{ left: column.x, width: column.width }}
                  data-nonworking={!column.isWorking || undefined}
                  data-week-start={column.isWeekStart || undefined}
                  data-month-start={column.isMonthStart || undefined}
                />
              ))}

              {/* Row bands, so hover and selection read across the full width. */}
              {rows.map((row) => (
                <div
                  key={row.task.id}
                  className="gantt__rowline"
                  style={{ top: row.rowIndex * view.metrics.rowHeight }}
                  data-task-id={row.task.id}
                  data-selected={selectedTaskId === row.task.id || undefined}
                  onClick={() => onSelectTask?.(row.task.id)}
                />
              ))}

              {todayOffset !== null && (
                <div className="gantt__today" style={{ left: todayOffset }} data-testid="gantt-today">
                  <span className="gantt__today-flag">TODAY</span>
                </div>
              )}

              {/* Baseline ghost bars, under the live bars. */}
              {rows.map((row) =>
                row.baseline ? (
                  <div
                    key={`baseline-${row.task.id}`}
                    className="gantt__baseline"
                    style={{
                      left: row.baseline.x,
                      top: row.baseline.y,
                      width: row.baseline.width,
                      height: row.baseline.height,
                    }}
                    data-testid={`baseline-${row.task.id}`}
                  />
                ) : null,
              )}

              <div className="gantt__bars">
                {rows.map((row) => (
                  <Row
                    key={row.task.id}
                    row={row}
                    view={view}
                    selected={selectedTaskId === row.task.id}
                    showCritical={showCritical}
                    locked={locked}
                    linkable={Boolean(onCreateLink)}
                    viewport={viewport}
                    previewDates={drag.previewDatesFor(row.task.id)}
                    isDragTarget={drag.preview?.hoverTaskId === row.task.id}
                    onPointerDown={drag.onPointerDown}
                    onSelect={() => onSelectTask?.(row.task.id)}
                  />
                ))}
              </div>

              <DependencyLayer
                arrows={arrows}
                width={scale.totalWidth}
                height={canvasHeight}
                selectedDependencyId={selectedDependencyId}
                {...(onSelectDependency ? { onSelectDependency } : {})}
                draft={draftLine}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  row: GanttRow;
  view: GanttView;
  selected: boolean;
  showCritical: boolean;
  locked: boolean;
  linkable: boolean;
  viewport: { scrollLeft: number; width: number };
  previewDates: TaskDates | null;
  isDragTarget: boolean;
  onPointerDown: ReturnType<typeof useBarDrag>['onPointerDown'];
  onSelect: () => void;
}

function Row({
  row,
  view,
  selected,
  showCritical,
  locked,
  linkable,
  viewport,
  previewDates,
  isDragTarget,
  onPointerDown,
  onSelect,
}: RowProps) {
  const { scale, metrics } = view;
  const { task, scheduled } = row;

  // While dragging, draw the preview dates instead of the committed schedule.
  const live = previewDates ?? {
    start: scheduled.start,
    end: scheduled.end,
    durationDays: scheduled.durationDays,
  };
  const dragging = previewDates !== null;

  const critical = showCritical && scheduled.isCritical;
  const label = task.name;
  const textWidth = estimateTextWidth(label);

  const handle = (mode: 'move' | 'resize-start' | 'resize-end' | 'link') =>
    (event: React.PointerEvent<Element>) =>
      onPointerDown(event, { id: task.id, ...live }, mode);

  if (scheduled.kind === 'milestone') {
    const cx = scale.centerOf(live.start);
    const cy = row.rowIndex * metrics.rowHeight + metrics.rowHeight / 2;
    const r = metrics.milestoneRadius;
    const placement = labelLayout({ cx, cy, r, points: '' }, textWidth, viewport);

    return (
      <>
        <svg
          className="gantt__milestone"
          style={{
            position: 'absolute',
            left: cx - r - 2,
            top: cy - r - 2,
            width: (r + 2) * 2,
            height: (r + 2) * 2,
            opacity: dragging ? 0.75 : undefined,
          }}
          data-task-id={task.id}
          data-testid={`milestone-${task.id}`}
          data-critical={critical || undefined}
          data-selected={selected || undefined}
          data-drop-target={isDragTarget || undefined}
          onPointerDown={locked ? undefined : handle('move')}
          onClick={onSelect}
        >
          <polygon
            className="gantt__milestone-shape"
            points={`${r + 2},2 ${r * 2 + 2},${r + 2} ${r + 2},${r * 2 + 2} 2,${r + 2}`}
            fill={row.color}
          />
        </svg>
        <span
          className="gantt__bar-label"
          style={{ left: placement.x, top: row.rowIndex * metrics.rowHeight }}
          data-placement={placement.placement}
        >
          {label}
        </span>
      </>
    );
  }

  const x = scale.xOf(live.start);
  const width = scale.widthOf(live.start, live.end);
  const fillWidth = width * Math.min(1, Math.max(0, scheduled.percentComplete / 100));
  const placement = labelLayout(
    { x, y: 0, width, height: metrics.barHeight, fillWidth, centerY: 0 },
    textWidth,
    viewport,
  );

  if (scheduled.kind === 'summary') {
    return (
      <>
        <div
          className="gantt__summary-bar"
          style={{
            left: x,
            width,
            top: row.rowIndex * metrics.rowHeight + (metrics.rowHeight - SUMMARY_BAR_HEIGHT) / 2,
            background: row.color,
          }}
          data-task-id={task.id}
          data-testid={`summary-${task.id}`}
          onClick={onSelect}
        />
        <span
          className="gantt__bar-label"
          style={{ left: placement.x, top: row.rowIndex * metrics.rowHeight }}
          data-placement={placement.placement}
        >
          {label}
        </span>
      </>
    );
  }

  const top = row.rowIndex * metrics.rowHeight + (metrics.rowHeight - metrics.barHeight) / 2;

  return (
    <>
      <div
        className="gantt__bar"
        role="button"
        tabIndex={0}
        style={{ left: x, top, width, height: metrics.barHeight, background: row.color }}
        data-task-id={task.id}
        data-testid={`bar-${task.id}`}
        data-critical={critical || undefined}
        data-selected={selected || undefined}
        data-dragging={dragging || undefined}
        data-locked={locked || undefined}
        data-drop-target={isDragTarget || undefined}
        title={`${task.name} — ${live.durationDays}d, ${Math.round(scheduled.percentComplete)}%`}
        onPointerDown={locked ? undefined : handle('move')}
        onClick={onSelect}
      >
        {/*
         * Veil the unfinished remainder rather than tinting the completed part, so the
         * bar keeps its full colour-by hue and the boundary lands at exactly
         * percent × width. CRITERIA: 60% must read as 60% of the bar's length.
         */}
        <div
          className="gantt__bar-remaining"
          style={{ width: width - fillWidth }}
          data-testid={`remaining-${task.id}`}
        />
        {!locked && (
          <>
            <span className="gantt__handle gantt__handle--start" onPointerDown={handle('resize-start')} />
            <span className="gantt__handle gantt__handle--end" onPointerDown={handle('resize-end')} />
          </>
        )}
      </div>

      {linkable && !locked && (
        <span
          className="gantt__linkdot"
          style={{ left: x + width + 3, top: top + metrics.barHeight / 2 }}
          data-testid={`linkdot-${task.id}`}
          data-active={dragging || undefined}
          onPointerDown={handle('link')}
        />
      )}

      <span
        className="gantt__bar-label"
        style={{
          left: placement.x,
          top: row.rowIndex * metrics.rowHeight,
          maxWidth: placement.maxWidth ?? undefined,
        }}
        data-placement={placement.placement}
      >
        {label}
      </span>
    </>
  );
}
