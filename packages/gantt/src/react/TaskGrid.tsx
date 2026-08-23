/**
 * The left pane: a WBS outline with the numbers that matter next to each row, editable
 * in place.
 *
 * Dates and durations are monospaced and right-aligned where they are quantities, so a
 * column of them reads as a column. Indentation carries hierarchy; the expander only
 * appears on rows that have something to expand.
 *
 * ── On editing ──────────────────────────────────────────────────────────────────────
 *
 * The grid stays presentational: it reports *intents* (`onEditTask`, `onRowAction`) and
 * never touches a project. The host decides what an edit means — notably that changing a
 * start date pins a constraint rather than storing a date, which is the invariant the
 * whole scheduler rests on.
 *
 * Three rules the cells follow:
 *
 * - **Derived fields are not editable.** A summary row's duration, dates, and percentage
 *   are rolled up from its children, and a milestone has no length. Offering an input
 *   there would invite an edit the scheduler must immediately overwrite.
 * - **Finish is always read-only.** Start and duration are the two independent values;
 *   finish is their consequence. Editing all three is how a Gantt tool ends up
 *   disagreeing with its own arrows.
 * - **Typing is local until committed.** A controlled input bound straight to scheduled
 *   output would fight the user mid-keystroke, because every commit reschedules the
 *   project and feeds a new value back down. Drafts commit on blur or Enter, and Escape
 *   abandons them.
 */

import { memo, useEffect, useRef, useState } from 'react';

import { toDayNum, toISO, type DayNum } from '../core/day.js';
import type { GanttRow } from './useGanttView.js';
import { initialsOf } from './palette.js';

/** A single committed cell edit. The host maps these onto project mutations. */
export type TaskGridEdit =
  | { field: 'name'; value: string }
  | { field: 'durationDays'; value: number }
  | { field: 'start'; value: DayNum }
  | { field: 'percentComplete'; value: number }
  | { field: 'assignee'; value: string | null };

export type TaskGridAction = 'add' | 'delete' | 'indent' | 'outdent';

export interface TaskGridProps {
  rows: readonly GanttRow[];
  /** Lets the chart measure the pane's real width instead of reconstructing it. */
  gridRef?: React.Ref<HTMLDivElement>;
  resourceNames: ReadonlyMap<string, string>;
  resourceColorOf: (resourceId: string) => string;
  selectedId: string | null;
  nameColumnWidth: number;
  /** Supplying the pointer handlers is what renders the splitter at all. */
  onSplitterPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
  onSplitterPointerMove?: (event: React.PointerEvent<HTMLElement>) => void;
  onSplitterPointerUp?: (event: React.PointerEvent<HTMLElement>) => void;
  onSplitterKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
  splitterDragging?: boolean;
  onSelect: (taskId: string) => void;
  onToggleCollapse: (taskId: string) => void;
  /** Turns the cells into inputs. Off while the project is view-only. */
  editable?: boolean;
  /** Offered in the "Who" cell. Without it that cell stays read-only avatars. */
  resources?: readonly { id: string; name: string }[];
  onEditTask?: (taskId: string, edit: TaskGridEdit) => void;
  onRowAction?: (taskId: string, action: TaskGridAction) => void;
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
  gridRef,
  resourceNames,
  resourceColorOf,
  selectedId,
  nameColumnWidth,
  onSplitterPointerDown,
  onSplitterPointerMove,
  onSplitterPointerUp,
  onSplitterKeyDown,
  splitterDragging,
  onSelect,
  onToggleCollapse,
  editable = false,
  resources,
  onEditTask,
  onRowAction,
}: TaskGridProps) {
  const referenceYear = rows.length > 0 ? Number(toISO(rows[0]!.scheduled.start).slice(0, 4)) : 0;
  const canEdit = editable && Boolean(onEditTask);

  return (
    <div
      ref={gridRef}
      className="gantt__grid"
      data-editable={canEdit || undefined}
      style={{ ['--gantt-col-name' as string]: `${nameColumnWidth}px` }}
    >
      {onSplitterPointerDown && (
        /*
         * Drag to widen the pane; arrow keys nudge it. A `separator` with an orientation
         * and a value is what a screen reader needs to report this as a resizer rather
         * than as an unlabelled button.
         */
        <div
          className="gantt__colsplit"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the task name column"
          aria-valuenow={Math.round(nameColumnWidth)}
          tabIndex={0}
          data-dragging={splitterDragging || undefined}
          onPointerDown={onSplitterPointerDown}
          {...(onSplitterPointerMove ? { onPointerMove: onSplitterPointerMove } : {})}
          {...(onSplitterPointerUp
            ? { onPointerUp: onSplitterPointerUp, onPointerCancel: onSplitterPointerUp }
            : {})}
          {...(onSplitterKeyDown ? { onKeyDown: onSplitterKeyDown } : {})}
          onClick={(event) => event.stopPropagation()}
        />
      )}

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
          const isSummary = scheduled.kind === 'summary';
          // A summary's numbers are rolled up from its children; a milestone has no
          // length. Neither can accept a duration or a percentage.
          const numbersEditable = canEdit && !isSummary && !isMilestone;
          const startEditable = canEdit && !isSummary;

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

                {canEdit ? (
                  <DraftInput
                    className="gantt__cell-input gantt__cell-input--name"
                    value={task.name}
                    ariaLabel={`Name of ${task.name}`}
                    onCommit={(next) => {
                      const trimmed = next.trim();
                      if (trimmed && trimmed !== task.name) {
                        onEditTask?.(task.id, { field: 'name', value: trimmed });
                      }
                    }}
                  />
                ) : (
                  <span className="gantt__name-text">{task.name}</span>
                )}

                {canEdit && onRowAction && (
                  <span className="gantt__rowtools">
                    <button
                      type="button"
                      className="gantt__rowtool"
                      title="Outdent"
                      aria-label={`Outdent ${task.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRowAction(task.id, 'outdent');
                      }}
                    >
                      ⇤
                    </button>
                    <button
                      type="button"
                      className="gantt__rowtool"
                      title="Indent"
                      aria-label={`Indent ${task.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRowAction(task.id, 'indent');
                      }}
                    >
                      ⇥
                    </button>
                    <button
                      type="button"
                      className="gantt__rowtool"
                      title="Add a task below"
                      aria-label={`Add a task below ${task.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRowAction(task.id, 'add');
                      }}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="gantt__rowtool gantt__rowtool--danger"
                      title="Delete this task and its subtree"
                      aria-label={`Delete ${task.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRowAction(task.id, 'delete');
                      }}
                    >
                      ×
                    </button>
                  </span>
                )}
              </div>

              <div className="gantt__cell gantt__cell--num" role="gridcell">
                {numbersEditable ? (
                  <DraftInput
                    className="gantt__cell-input gantt__cell-input--num"
                    type="number"
                    min={0}
                    value={String(scheduled.durationDays)}
                    ariaLabel={`Duration in days of ${task.name}`}
                    onCommit={(next) => {
                      const days = Math.max(0, Math.round(Number(next)));
                      if (Number.isFinite(days) && days !== scheduled.durationDays) {
                        onEditTask?.(task.id, { field: 'durationDays', value: days });
                      }
                    }}
                  />
                ) : isMilestone ? (
                  '—'
                ) : (
                  scheduled.durationDays
                )}
              </div>

              <div className="gantt__cell gantt__cell--date" role="gridcell">
                {startEditable ? (
                  <DraftInput
                    className="gantt__cell-input gantt__cell-input--date"
                    type="date"
                    value={toISO(scheduled.start)}
                    ariaLabel={`Start date of ${task.name}`}
                    onCommit={(next) => {
                      if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return;
                      let day: DayNum;
                      try {
                        day = toDayNum(next);
                      } catch {
                        return; // An out-of-range date: leave the schedule alone.
                      }
                      if (day !== scheduled.start) {
                        onEditTask?.(task.id, { field: 'start', value: day });
                      }
                    }}
                  />
                ) : (
                  shortDate(scheduled.start, referenceYear)
                )}
              </div>

              {/* Finish is derived from start + duration, so it is never an input. */}
              <div className="gantt__cell gantt__cell--date" role="gridcell">
                {isMilestone ? '—' : shortDate(scheduled.end, referenceYear)}
              </div>

              <div className="gantt__cell gantt__cell--num" role="gridcell">
                {numbersEditable ? (
                  <DraftInput
                    className="gantt__cell-input gantt__cell-input--num"
                    type="number"
                    min={0}
                    max={100}
                    value={String(Math.round(scheduled.percentComplete))}
                    ariaLabel={`Percent complete of ${task.name}`}
                    onCommit={(next) => {
                      const percent = Math.min(100, Math.max(0, Math.round(Number(next))));
                      if (
                        Number.isFinite(percent) &&
                        percent !== Math.round(scheduled.percentComplete)
                      ) {
                        onEditTask?.(task.id, { field: 'percentComplete', value: percent });
                      }
                    }}
                  />
                ) : isMilestone ? (
                  '—'
                ) : (
                  `${Math.round(scheduled.percentComplete)}`
                )}
              </div>

              {canEdit && resources ? (
                <div className="gantt__cell gantt__cell--who" role="gridcell">
                  <select
                    className="gantt__cell-input gantt__cell-input--select"
                    aria-label={`Assignee of ${task.name}`}
                    value={task.assigneeIds[0] ?? ''}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      onEditTask?.(task.id, {
                        field: 'assignee',
                        value: event.target.value || null,
                      })
                    }
                  >
                    <option value="">—</option>
                    {resources.map((resource) => (
                      <option key={resource.id} value={resource.id}>
                        {resource.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
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
              )}
            </div>
          );
        })}
      </div>

      {canEdit && onRowAction && rows.length > 0 && (
        <div className="gantt__grid-foot">
          <button
            type="button"
            className="gantt__addrow"
            onClick={() => onRowAction(rows[rows.length - 1]!.task.id, 'add')}
          >
            + Add task
          </button>
        </div>
      )}
    </div>
  );
});

interface DraftInputProps {
  value: string;
  onCommit: (value: string) => void;
  className: string;
  ariaLabel: string;
  type?: 'text' | 'number' | 'date';
  min?: number;
  max?: number;
}

/**
 * An input that holds its own text until the edit is finished.
 *
 * Every commit reschedules the project, which sends a *new* `value` back down — for a
 * duration change, often a different one than was typed, because the scheduler snaps off
 * non-working days. Binding the input straight to that would rewrite the field under the
 * user's cursor. So the draft is local while focused, and `value` only reclaims the field
 * once focus leaves.
 */
function DraftInput({ value, onCommit, className, ariaLabel, type = 'text', min, max }: DraftInputProps) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  return (
    <input
      className={className}
      type={type}
      aria-label={ariaLabel}
      value={draft}
      {...(min !== undefined ? { min } : {})}
      {...(max !== undefined ? { max } : {})}
      onClick={(event) => event.stopPropagation()}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        focused.current = false;
        onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(value);
          focused.current = false;
          event.currentTarget.blur();
          return;
        }
        // Arrow keys nudge the selected task at the window level; inside a field they
        // belong to the caret.
        event.stopPropagation();
      }}
    />
  );
}
