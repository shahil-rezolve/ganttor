/**
 * `@ganttor/gantt` — a dependency-aware Gantt scheduling engine and renderer.
 *
 * The package is split so the hard part is reusable on its own:
 *
 * - `@ganttor/gantt/core` — the scheduler. Pure TypeScript: four dependency types with
 *   lag, working-day calendars, WBS rollups, cycle detection, and CPM. No React, no
 *   DOM, no I/O.
 * - `@ganttor/gantt` — the above plus a React renderer built from DOM rows and an SVG
 *   arrow overlay. Import `@ganttor/gantt/styles.css` alongside it.
 *
 * ```tsx
 * import { GanttChart, schedule, createDemoProject } from '@ganttor/gantt';
 * import '@ganttor/gantt/styles.css';
 *
 * const project = createDemoProject();
 * const result = schedule(project);   // dates, float, critical path — no UI needed
 *
 * <GanttChart project={project} unit="week" onChangeDates={…} />
 * ```
 */

export * from './core/index.js';

export { GanttChart, type GanttChartProps } from './react/GanttChart.js';
export {
  TaskGrid,
  type TaskGridProps,
  type TaskGridEdit,
  type TaskGridAction,
} from './react/TaskGrid.js';
export { TimelineHeader, type TimelineHeaderProps } from './react/TimelineHeader.js';
export { DependencyLayer, type DependencyLayerProps } from './react/DependencyLayer.js';
export { Legend, type LegendProps } from './react/Legend.js';
export {
  useGanttView,
  todayX,
  type GanttView,
  type GanttRow,
  type GanttArrow,
  type UseGanttViewOptions,
} from './react/useGanttView.js';
export {
  useBarDrag,
  type BarDragHandlers,
  type DragMode,
  type DragPreview,
  type UseBarDragOptions,
} from './react/useBarDrag.js';
export * from './react/geometry.js';
export * from './react/palette.js';

export { createDemoProject, PROJECT_START, DEMO_START_DAY } from './fixtures/demo.js';
