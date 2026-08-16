/**
 * The dependency arrow overlay.
 *
 * A single SVG sized to the whole canvas, so arrows can run between any two rows
 * without being clipped by row boxes. Each arrow gets a wide transparent companion
 * stroke — a 1px line is impossible to click otherwise.
 *
 * Arrowheads are drawn as explicit triangles rather than with `marker-end`, because a
 * marker inherits the path's stroke width and a critical link's thicker stroke would
 * silently scale its head.
 */

import { memo } from 'react';

import type { GanttArrow } from './useGanttView.js';

export interface DependencyLayerProps {
  arrows: readonly GanttArrow[];
  width: number;
  height: number;
  selectedDependencyId: string | null;
  onSelectDependency?: (dependencyId: string) => void;
  /** Rubber-band line while a new link is being dragged out. */
  draft?: { x1: number; y1: number; x2: number; y2: number } | null;
}

const HEAD = 4;

export const DependencyLayer = memo(function DependencyLayer({
  arrows,
  width,
  height,
  selectedDependencyId,
  onSelectDependency,
  draft,
}: DependencyLayerProps) {
  return (
    <svg
      className="gantt__arrows"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {arrows.map((arrow) => {
        const { id } = arrow.dependency;
        const critical = arrow.isCritical || undefined;
        const cyclic = arrow.isCyclic || undefined;
        const { x, y, angle } = arrow.path.head;

        return (
          <g key={id} data-dependency-id={id} data-type={arrow.dependency.type}>
            <polyline
              className="gantt__arrow"
              points={arrow.path.points}
              data-critical={critical}
              data-cyclic={cyclic}
              data-selected={selectedDependencyId === id || undefined}
            />
            <polygon
              className="gantt__arrow-head"
              data-critical={critical}
              data-cyclic={cyclic}
              points={`0,0 ${-HEAD * 1.6},${-HEAD} ${-HEAD * 1.6},${HEAD}`}
              transform={`translate(${x} ${y}) rotate(${angle})`}
            />
            {onSelectDependency && (
              <polyline
                className="gantt__arrow-hit"
                points={arrow.path.points}
                onClick={() => onSelectDependency(id)}
              />
            )}
          </g>
        );
      })}

      {draft && (
        <polyline
          className="gantt__linkdraft"
          points={`${draft.x1},${draft.y1} ${draft.x2},${draft.y2}`}
        />
      )}
    </svg>
  );
});
