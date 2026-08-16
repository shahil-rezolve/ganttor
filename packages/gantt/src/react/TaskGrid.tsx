/**
 * The left pane: a WBS outline with the numbers that matter next to each row.
 *
 * Dates and durations are monospaced and right-aligned where they are quantities, so a
 * column of them reads as a column. Indentation carries hierarchy; the expander only
 * appears on rows that have something to expand.
 */

import { memo } from 'react';

import { toISO } from '../core/day.js';
import type { GanttRow } from './useGanttView.js';
import { initialsOf } from './palette.js';

export interface TaskGridProps {
  rows: readonly GanttRow[];
  resourceNames: ReadonlyMap<string, string>;
  resourceColorOf: (resourceId: string) => string;
  selectedId: string | null;
  nameColumnWidth: number;
  onSelect: (taskId: string) => void;
  onToggleCollapse: (taskId: string) => void;
}

/** Compact date: `12 Mar`, with the year only when it is not the project's. */
function shortDate(day: number, referenceYear: number): string {
  const iso = toISO(day);
  const [year, month, dayOfMonth] = iso.split('-') as [string, string, string];
  const monthName = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][Number(month) - 1]!;
  const base = `${Number(dayOfMonth)} ${monthName}`;
  return Number(year) === referenceYear ? base : `${base} ’${year.slice(2)}`;
}

export const TaskGrid = memo(function TaskGrid({
  rows,
  resourceNames,
  resourceColorOf,
  selectedId,
  nameColumnWidth,
  onSelect,
  onToggleCollapse,
}: TaskGridProps) {
  const referenceYear = rows.length > 0 ? Number(toISO(rows[0]!.scheduled.start).slice(0, 4)) : 0;

  return (
    <div className="gantt__grid" style={{ ['--gantt-col-name' as string]: `${nameColumnWidth}px` }}>
      <div className="gantt__grid-head">
        <div className="gantt__grid-head-row" role="row">
          <div className="gantt__cell" role="columnheader">
            Task
          </div>
          <div className="gantt__cell gantt__cell--num" role="columnheader">
            Days
          </div>
          <div className="gantt__cell gantt__cell--date" role="columnheader">
            Start
          </div>
          <div className="gantt__cell gantt__cell--date" role="columnheader">
            Finish
          </div>
          <div className="gantt__cell gantt__cell--num" role="columnheader">
            %
          </div>
          <div className="gantt__cell" role="columnheader">
            Who
          </div>
        </div>
      </div>

      <div role="rowgroup">
        {rows.map((row) => {
          const { task, scheduled } = row;
          const isMilestone = scheduled.kind === 'milestone';

          return (
            <div
              key={task.id}
              className="gantt__grid-row"
              role="row"
              data-task-id={task.id}
              data-kind={scheduled.kind}
              data-selected={selectedId === task.id}
              data-critical={scheduled.isCritical}
              onClick={() => onSelect(task.id)}
            >
              <div
                className="gantt__cell gantt__cell--name"
                role="gridcell"
                style={{ paddingLeft: 8 + row.depth * 13 }}
                title={task.name}
              >
                {row.hasChildren ? (
                  <button
                    type="button"
                    className="gantt__expander"
                    aria-label={row.collapsed ? `Expand ${task.name}` : `Collapse ${task.name}`}
                    aria-expanded={!row.collapsed}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleCollapse(task.id);
                    }}
                  >
                    {row.collapsed ? '▸' : '▾'}
                  </button>
                ) : (
                  <span className="gantt__expander-spacer" aria-hidden="true" />
                )}
                {task.jiraKey && <span className="gantt__key">{task.jiraKey}</span>}
                <span className="gantt__name-text">{task.name}</span>
              </div>

              <div className="gantt__cell gantt__cell--num" role="gridcell">
                {isMilestone ? '—' : scheduled.durationDays}
              </div>
              <div className="gantt__cell gantt__cell--date" role="gridcell">
                {shortDate(scheduled.start, referenceYear)}
              </div>
              <div className="gantt__cell gantt__cell--date" role="gridcell">
                {isMilestone ? '—' : shortDate(scheduled.end, referenceYear)}
              </div>
              <div className="gantt__cell gantt__cell--num" role="gridcell">
                {isMilestone ? '—' : `${Math.round(scheduled.percentComplete)}`}
              </div>

              <div className="gantt__avatars" role="gridcell">
                {task.assigneeIds.slice(0, 2).map((id) => {
                  const name = resourceNames.get(id) ?? id;
                  return (
                    <span
                      key={id}
                      className="gantt__avatar"
                      style={{ background: resourceColorOf(id) }}
                      title={name}
                    >
                      {initialsOf(name)}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
