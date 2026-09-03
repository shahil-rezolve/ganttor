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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { todayDayNum, type DayNum } from '../core/day.js';
import type { TaskDates } from '../core/duration.js';
import type { ScaleUnit } from '../core/timescale.js';
import type { Project } from '../core/types.js';
import { growAxis as growAxisWindow, initialPad, type AxisPad } from './axisWindow.js';
import { DependencyLayer } from './DependencyLayer.js';
import { estimateTextWidth, labelLayout, type RowMetrics } from './geometry.js';
import { CATEGORICAL, categoricalIndex } from './palette.js';
import { TaskGrid, type TaskGridAction, type TaskGridEdit } from './TaskGrid.js';
import { TimelineHeader } from './TimelineHeader.js';
import { useBarDrag } from './useBarDrag.js';
import { todayX, useGanttView, type GanttRow, type GanttView } from './useGanttView.js';

/** Matches `.gantt__summary-bar`'s height in gantt.css, which centres it in its row. */
const SUMMARY_BAR_HEIGHT = 11;

/** Bounds for the name column, whether auto-fitted or dragged. */
export const NAME_COLUMN_MIN = 180;
export const NAME_COLUMN_MAX = 620;

/**
 * Timeline width the auto-fit will not encroach on.
 *
 * Auto-fitting to the longest name alone is the wrong objective: the five fixed columns
 * beside it already take ~379px, so on a 1280px window with the detail panel open a
 * greedy name column leaves almost no chart to look at.
 *
 * Tuned so that the tightest case — a 1280px window with the panel open — still yields a
 * 300px name column, matching the old fixed default. That is the floor, not the target:
 * the reserve only binds on a small window, so a roomier screen genuinely does fit the
 * longest name. Reserving more than this is a false economy — it starves the column until
 * the names disappear altogether, which is worse than truncating them.
 */
const MIN_TIMELINE_WIDTH = 240;

/**
 * The axis window when `growAxis` is off: the original symmetric week either side.
 * Kept as the default so the component's geometry is unchanged for existing consumers.
 */
const STATIC_PAD: AxisPad = { before: 7, after: 7 };

function clampNameColumn(px: number): number {
  return Math.min(NAME_COLUMN_MAX, Math.max(NAME_COLUMN_MIN, Math.round(px)));
}

export interface GanttChartProps {
  project: Project;
  unit: ScaleUnit;
  selectedTaskId?: string | null;
  selectedDependencyId?: string | null;
  /** Overridden in tests so a snapshot does not depend on the day it runs. */
  today?: DayNum;
  theme?: 'light' | 'dark';
  metrics?: RowMetrics;
  /**
   * Width of the WBS name column. Omit to auto-fit it to the longest visible name —
   * supplying it (as the app does once the splitter has been dragged) takes over.
   */
  nameColumnWidth?: number;
  /** The splitter was dragged. Persist this to keep the width across reloads. */
  onNameColumnWidthChange?: (px: number) => void;
  /**
   * Hide the left-hand WBS pane so the bars get the whole width.
   *
   * The grid is hidden with CSS rather than unmounted, deliberately. The measurement
   * effect observes `gridRef` once, with `[]` deps; unmounting the grid would orphan
   * that observer, and it would never re-attach to the remount. `display: none` also
   * makes `offsetWidth` read 0, which is already the right value for every width sum
   * below — no collapsed-state arithmetic anywhere.
   */
  gridCollapsed?: boolean;
  /**
   * Extend the axis as the view approaches either end, instead of spanning only the
   * project's own dates plus a week.
   *
   * Opt-in rather than default: an unbounded axis is a host's decision, and defaulting
   * it on would silently change the geometry every existing consumer renders.
   */
  growAxis?: boolean;
  /**
   * Increment to scroll the view back to today. A token rather than a method so the
   * component needs no imperative handle.
   */
  scrollToTodayToken?: number;
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
  nameColumnWidth,
  onNameColumnWidthChange,
  gridCollapsed = false,
  growAxis = false,
  scrollToTodayToken = 0,
  onSelectTask,
  onSelectDependency,
  onToggleCollapse,
  onChangeDates,
  onCreateLink,
  onEditTask,
  onRowAction,
  onView,
}: GanttChartProps) {
  /*
   * ── The axis window ──────────────────────────────────────────────────────────────
   * Held here rather than derived, because it grows in response to scrolling. Reset when
   * the zoom changes: the opening pad is unit-aware, since padding is really about screen
   * room and a day is 34px at day zoom but 1.6px at quarter zoom.
   */
  const [pad, setPad] = useState<AxisPad>(() => (growAxis ? initialPad(unit) : STATIC_PAD));
  const [padUnit, setPadUnit] = useState(unit);
  if (padUnit !== unit) {
    setPadUnit(unit);
    setPad(growAxis ? initialPad(unit) : STATIC_PAD);
  }

  const view = useGanttView({
    project,
    unit,
    ...(metrics ? { metrics } : {}),
    padBefore: pad.before,
    padAfter: pad.after,
  });
  const { scale, rows, arrows, calendar, canvasHeight, resourceNames } = view;

  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ scrollLeft: 0, width: 1200 });
  /** Real geometry, used to keep the auto-fit from eating the whole chart. */
  const [measured, setMeasured] = useState({ containerWidth: 0, otherColumns: 0 });

  useLayoutEffect(() => {
    onView?.(view);
  }, [view, onView]);

  /*
   * Width the name column wants in order to show its longest visible name in full.
   * Used only while the host has not supplied a width of its own.
   */
  const autoFitNameWidth = useMemo(() => {
    let widest = 0;
    for (const row of rows) {
      // Indent, expander, and the optional Jira key all sit left of the name text.
      const lead = 8 + row.depth * 13 + 22;
      const key = row.task.jiraKey ? estimateTextWidth(row.task.jiraKey, 12) + 6 : 0;
      widest = Math.max(widest, lead + key + estimateTextWidth(row.task.name, 13) + 26);
    }
    return clampNameColumn(widest);
  }, [rows]);

  /*
   * How much the auto-fit is actually allowed. `otherColumns` is measured rather than
   * hard-coded, so it cannot drift from the stylesheet's track widths. Before the first
   * measurement it is 0 and the cap is inert, which settles on the next layout pass.
   */
  const autoFitCap =
    measured.containerWidth > 0 && measured.otherColumns > 0
      ? measured.containerWidth - measured.otherColumns - MIN_TIMELINE_WIDTH
      : NAME_COLUMN_MAX;

  const resolvedNameWidth =
    nameColumnWidth === undefined
      ? clampNameColumn(Math.min(autoFitNameWidth, autoFitCap))
      : // An explicit width is the user's own choice; only the hard bounds apply.
        clampNameColumn(nameColumnWidth);

  /*
   * Read by the scroll handler, which must not be re-subscribed on every zoom or pad
   * change — a listener that is torn down and rebuilt mid-gesture drops events.
   */
  const live = useRef({ pxPerDay: scale.pxPerDay, growAxis, pad, nameWidth: 0 });
  live.current = { pxPerDay: scale.pxPerDay, growAxis, pad, nameWidth: resolvedNameWidth };

  /*
   * Growing the axis *leftwards* shifts every x-coordinate right, so the scroller has to
   * be corrected by the same number of pixels or the content visibly jumps under the
   * cursor. Recorded here and applied in the layout tick that renders the new origin.
   */
  const pendingCorrection = useRef(0);

  /*
   * Label placement depends on where the viewport is, so it needs measuring — but only
   * to decide inside/after/before, never to compute bar geometry.
   *
   * The measurement is in *canvas* coordinates. `.gantt__canvas` begins where the sticky
   * left pane ends, so the visible slice of canvas is `[scrollLeft, scrollLeft +
   * clientWidth − gridWidth]`. The grid's real `offsetWidth` is measured rather than
   * reconstructed from the column widths, which is what previously required a `386`
   * literal standing in for the five non-name tracks — and drifted from the stylesheet.
   */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const measure = () => {
      const gridWidth = gridRef.current?.offsetWidth ?? 0;
      const next = {
        scrollLeft: element.scrollLeft,
        width: Math.max(0, element.clientWidth - gridWidth),
      };
      // Compare values, not object identity: scroll fires far more often than the
      // measurement actually changes, and each new object would re-render the chart.
      setViewport((current) =>
        current.scrollLeft === next.scrollLeft && current.width === next.width ? current : next,
      );

      // `gridWidth − nameWidth` is the five fixed tracks plus the pane border. Derived
      // from the live DOM rather than restated as a constant, which is how the old `386`
      // literal came to be ~7px wrong.
      if (gridWidth > 0) {
        const nextMeasured = {
          containerWidth: element.clientWidth,
          otherColumns: Math.max(0, gridWidth - live.current.nameWidth),
        };
        setMeasured((current) =>
          current.containerWidth === nextMeasured.containerWidth &&
          current.otherColumns === nextMeasured.otherColumns
            ? current
            : nextMeasured,
        );
      }

      const { pxPerDay, growAxis: enabled, pad: currentPad } = live.current;
      // Until the opening position is set, `scrollLeft` is 0 because nothing has
      // scrolled yet — not because the user reached the start.
      if (!enabled || !didInitialScroll.current) return;
      const grown = growAxisWindow(
        {
          scrollLeft: element.scrollLeft,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          pxPerDay,
        },
        currentPad,
      );
      if (grown.pad !== currentPad) {
        pendingCorrection.current += grown.scrollCorrection;
        setPad(grown.pad);
      }
    };

    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (gridRef.current) observer.observe(gridRef.current);
    return () => {
      element.removeEventListener('scroll', measure);
      observer.disconnect();
    };
    // Re-run on a collapse toggle so the measurement refreshes on that frame rather
    // than waiting for the next scroll or resize. Re-binding the listener and observer
    // is cheap, and it keeps the effect honest about what it depends on.
  }, [gridCollapsed]);

  // Keyed on the origin: it changes exactly when leftward growth shifted the content.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || pendingCorrection.current === 0) return;
    element.scrollLeft += pendingCorrection.current;
    pendingCorrection.current = 0;
  }, [scale.originDay]);

  /*
   * ── Where the chart opens ────────────────────────────────────────────────────────
   *
   * Only relevant with `growAxis`, and required by it. The axis now starts a screenful
   * *before* the project does, so leaving the scroller at 0 would open the chart on
   * empty padding — the work sitting off-screen to the right. Anchor on today when the
   * project is underway, otherwise on its start, and leave a little lead-in so the first
   * bar is not flush against the pane divider.
   */
  const didInitialScroll = useRef(false);

  useLayoutEffect(() => {
    if (!growAxis || didInitialScroll.current) return;
    const element = scrollRef.current;
    if (!element || rows.length === 0) return;

    const gridWidth = gridRef.current?.offsetWidth ?? 0;
    const visible = element.clientWidth - gridWidth;
    // Nothing has been laid out yet; try again on the next measurement.
    if (visible <= 0) return;

    /*
     * Today only when the project is actually underway. Clamping today into the span
     * instead would open a finished project at its *end*, with all the work off-screen
     * to the left — worse than useless.
     */
    const underway =
      todayDay >= view.result.projectStart && todayDay <= view.result.projectFinish;
    const anchorDay = underway ? todayDay : view.result.projectStart;
    element.scrollLeft = Math.max(0, scale.xOf(anchorDay) - visible * 0.12);
    didInitialScroll.current = true;
  });

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

  /*
   * Jump back to today, centred in the visible slice of canvas.
   *
   * Depends only on the token: re-running whenever the scale or the offset changed would
   * yank the view back to today on every zoom and every edit.
   */
  useEffect(() => {
    if (scrollToTodayToken === 0) return;
    const element = scrollRef.current;
    if (!element || todayOffset === null) return;
    const gridWidth = gridRef.current?.offsetWidth ?? 0;
    const visible = Math.max(0, element.clientWidth - gridWidth);
    element.scrollLeft = Math.max(0, todayOffset - visible / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- token-driven by design
  }, [scrollToTodayToken]);

  /* ── The grid / timeline splitter ──────────────────────────────────────────────── */

  const splitGesture = useRef<{ startX: number; startWidth: number } | null>(null);
  const [splitDragging, setSplitDragging] = useState(false);

  const onSplitterPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!onNameColumnWidthChange) return;
      // Pointer capture keeps the gesture alive outside the 9px target, past the pane
      // edge, and outside the window — with no document-level listener to leak.
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      splitGesture.current = { startX: event.clientX, startWidth: resolvedNameWidth };
      setSplitDragging(true);
    },
    [onNameColumnWidthChange, resolvedNameWidth],
  );

  const onSplitterPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const gesture = splitGesture.current;
      if (!gesture) return;
      onNameColumnWidthChange?.(
        clampNameColumn(gesture.startWidth + (event.clientX - gesture.startX)),
      );
    },
    [onNameColumnWidthChange],
  );

  const onSplitterPointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!splitGesture.current) return;
    splitGesture.current = null;
    setSplitDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  // Keyboard resizing, so the splitter is not pointer-only.
  const onSplitterKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (!onNameColumnWidthChange) return;
      const step = event.shiftKey ? 40 : 12;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        onNameColumnWidthChange(clampNameColumn(resolvedNameWidth - step));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        onNameColumnWidthChange(clampNameColumn(resolvedNameWidth + step));
      }
    },
    [onNameColumnWidthChange, resolvedNameWidth],
  );

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
        <div className="gantt__layout" data-grid-collapsed={gridCollapsed || undefined}>
          <TaskGrid
            rows={rows}
            gridRef={gridRef}
            resourceNames={resourceNames}
            resourceColorOf={resourceColorOf}
            selectedId={selectedTaskId}
            nameColumnWidth={resolvedNameWidth}
            splitterDragging={splitDragging}
            {...(onNameColumnWidthChange
              ? {
                  onSplitterPointerDown,
                  onSplitterPointerMove,
                  onSplitterPointerUp,
                  onSplitterKeyDown,
                }
              : {})}
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
                    canvasWidth={scale.totalWidth}
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
  /** Bounds an outside label to the axis, so it cannot inflate `scrollWidth`. */
  canvasWidth: number;
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
  canvasWidth,
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
    const placement = labelLayout({ cx, cy, r, points: '' }, textWidth, viewport, 8, canvasWidth);

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

  const x = scale.xOf(live.start);
  const width = scale.widthOf(live.start, live.end);
  const fillWidth = width * Math.min(1, Math.max(0, scheduled.percentComplete / 100));
  const placement = labelLayout(
    { x, y: 0, width, height: metrics.barHeight, fillWidth, centerY: 0 },
    textWidth,
    viewport,
    8,
    canvasWidth,
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
