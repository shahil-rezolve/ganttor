/**
 * The task detail panel.
 *
 * Read-only *derived* values (dates, float, criticality, baseline variance) sit next to
 * the editable *inputs* (duration, status, progress, assignees, dependency type and
 * lag). Keeping the distinction visible is the point: a user who understands that dates
 * are computed will trust the schedule, and one who thinks they were typed in will not.
 */

import {
  computeVariance,
  DEP_TYPE_LABELS,
  DEP_TYPES,
  PRIORITIES,
  TASK_STATUSES,
  toISO,
  type Dependency,
  type DepType,
  type GanttView,
  type Priority,
  type TaskStatus,
} from '@ganttor/gantt';

import { useProjectStore } from '../store/useProjectStore.js';

export interface TaskPanelProps {
  view: GanttView | null;
}

export function TaskPanel({ view }: TaskPanelProps) {
  const project = useProjectStore((s) => s.project);
  const selectedTaskId = useProjectStore((s) => s.selectedTaskId);
  const updateTask = useProjectStore((s) => s.updateTask);
  const removeTask = useProjectStore((s) => s.removeTask);
  const indentTask = useProjectStore((s) => s.indentTask);
  const outdentTask = useProjectStore((s) => s.outdentTask);
  const moveTaskUp = useProjectStore((s) => s.moveTaskUp);
  const moveTaskDown = useProjectStore((s) => s.moveTaskDown);
  const clearConstraint = useProjectStore((s) => s.clearConstraint);
  const updateLink = useProjectStore((s) => s.updateLink);
  const removeLink = useProjectStore((s) => s.removeLink);
  const selectTask = useProjectStore((s) => s.selectTask);

  const locked = project.settings.locked;
  const task = project.tasks.find((t) => t.id === selectedTaskId);
  const scheduled = selectedTaskId ? view?.result.tasks.get(selectedTaskId) : undefined;

  if (!task || !scheduled || !view) {
    return (
      <div className="ganttor-panel">
        <div className="ganttor-panel__head">
          <span className="ganttor-panel__title">Task details</span>
        </div>
        <div className="ganttor-empty">Select a task to see and edit its details.</div>
      </div>
    );
  }

  const nameOf = (id: string): string => {
    const other = project.tasks.find((t) => t.id === id);
    return other?.name ?? id;
  };
  const keyOf = (id: string): string | undefined =>
    project.tasks.find((t) => t.id === id)?.jiraKey;

  const predecessors = project.dependencies.filter((d) => d.successorId === task.id);
  const successors = project.dependencies.filter((d) => d.predecessorId === task.id);

  const variance = view.baseline
    ? computeVariance(view.calendar, view.baseline.bars[task.id], scheduled)
    : null;

  const isSummary = scheduled.kind === 'summary';
  const isMilestone = scheduled.kind === 'milestone';

  return (
    <div className="ganttor-panel">
      <div className="ganttor-panel__head">
        <span className="ganttor-panel__title">
          {task.jiraKey ? `${task.jiraKey} · ` : ''}
          {isSummary ? 'Summary' : isMilestone ? 'Milestone' : 'Task'}
        </span>
        <button
          type="button"
          className="ganttor-btn ganttor-btn--ghost ganttor-btn--danger"
          onClick={() => removeTask(task.id)}
          disabled={locked}
        >
          Delete
        </button>
      </div>

      <div className="ganttor-panel__body">
        <div className="ganttor-field">
          <span className="ganttor-field__label">Name</span>
          <input
            className="ganttor-input"
            value={task.name}
            disabled={locked}
            onChange={(event) => updateTask(task.id, { name: event.target.value })}
          />
        </div>

        {/* ── Derived: the schedule's own output ─────────────────────────────────── */}
        <div className="ganttor-section">
          <span className="ganttor-section__title">Schedule</span>
          <div className="ganttor-stat">
            <span className="ganttor-stat__label">Start</span>
            <span className="ganttor-stat__value">{toISO(scheduled.start)}</span>
          </div>
          <div className="ganttor-stat">
            <span className="ganttor-stat__label">Finish</span>
            <span className="ganttor-stat__value">
              {isMilestone ? '—' : toISO(scheduled.end)}
            </span>
          </div>
          <div className="ganttor-stat">
            <span className="ganttor-stat__label">Total float</span>
            <span
              className={
                scheduled.isCritical
                  ? 'ganttor-stat__value ganttor-stat__value--critical'
                  : 'ganttor-stat__value'
              }
            >
              {isSummary ? '—' : `${scheduled.totalFloat}d`}
              {scheduled.isCritical && !isSummary ? ' · critical' : ''}
            </span>
          </div>
          {scheduled.conflicts.length > 0 && (
            <div className="ganttor-stat">
              <span className="ganttor-stat__label">Conflict</span>
              <span className="ganttor-stat__value ganttor-stat__value--critical">
                {scheduled.conflicts
                  .map((c) =>
                    c === 'in-cycle' ? 'on a dependency loop' : 'pinned date is unreachable',
                  )
                  .join(', ')}
              </span>
            </div>
          )}
          {isSummary && (
            <span className="ganttor-field__hint">
              Dates and progress are rolled up from this task’s children and cannot be set
              directly.
            </span>
          )}
        </div>

        {/* ── Editable ──────────────────────────────────────────────────────────── */}
        {!isSummary && (
          <div className="ganttor-grid2">
            <label className="ganttor-field">
              <span className="ganttor-field__label">Duration (days)</span>
              <input
                type="number"
                min={0}
                className="ganttor-input ganttor-input--num"
                value={task.durationDays}
                disabled={locked}
                onChange={(event) =>
                  updateTask(task.id, { durationDays: clampInt(event.target.value, 0, 3650) })
                }
              />
              <span className="ganttor-field__hint">0 makes it a milestone.</span>
            </label>

            <label className="ganttor-field">
              <span className="ganttor-field__label">Complete (%)</span>
              <input
                type="number"
                min={0}
                max={100}
                className="ganttor-input ganttor-input--num"
                value={Math.round(task.percentComplete)}
                disabled={locked || isMilestone}
                onChange={(event) =>
                  updateTask(task.id, { percentComplete: clampInt(event.target.value, 0, 100) })
                }
              />
            </label>
          </div>
        )}

        <div className="ganttor-grid2">
          <label className="ganttor-field">
            <span className="ganttor-field__label">Status</span>
            <select
              className="ganttor-select"
              value={task.status}
              disabled={locked}
              onChange={(event) =>
                updateTask(task.id, { status: event.target.value as TaskStatus })
              }
            >
              {TASK_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>

          <label className="ganttor-field">
            <span className="ganttor-field__label">Priority</span>
            <select
              className="ganttor-select"
              value={task.priority}
              disabled={locked}
              onChange={(event) =>
                updateTask(task.id, { priority: event.target.value as Priority })
              }
            >
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priority}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="ganttor-field">
          <span className="ganttor-field__label">Assignees</span>
          <select
            className="ganttor-select"
            multiple
            size={Math.min(5, Math.max(2, project.resources.length))}
            value={task.assigneeIds}
            disabled={locked}
            onChange={(event) =>
              updateTask(task.id, {
                assigneeIds: [...event.target.selectedOptions].map((option) => option.value),
              })
            }
          >
            {project.resources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name}
              </option>
            ))}
          </select>
        </div>

        {task.constraint && (
          <div className="ganttor-section">
            <span className="ganttor-section__title">Pinned date</span>
            <div className="ganttor-row ganttor-row--split">
              <span className="ganttor-stat__value">
                {task.constraint.type === 'SNET' ? 'Starts no earlier than' : 'Must start on'}{' '}
                {toISO(task.constraint.day)}
              </span>
              <button
                type="button"
                className="ganttor-btn ganttor-btn--ghost"
                onClick={() => clearConstraint(task.id)}
                disabled={locked}
              >
                Unpin
              </button>
            </div>
            <span className="ganttor-field__hint">
              Set when you drag a bar. Unpinning lets the task float back to its earliest
              possible date.
            </span>
          </div>
        )}

        {variance && (
          <div className="ganttor-section">
            <span className="ganttor-section__title">
              Vs. baseline “{view.baseline?.name}”
            </span>
            <div className="ganttor-stat">
              <span className="ganttor-stat__label">Finish</span>
              <span
                className={
                  variance.isSlipping
                    ? 'ganttor-stat__value ganttor-stat__value--critical'
                    : 'ganttor-stat__value ganttor-stat__value--ok'
                }
              >
                {signed(variance.endDelta)}d
              </span>
            </div>
            <div className="ganttor-stat">
              <span className="ganttor-stat__label">Duration</span>
              <span className="ganttor-stat__value">{signed(variance.durationDelta)}d</span>
            </div>
          </div>
        )}

        <DependencyList
          title="Predecessors"
          dependencies={predecessors}
          otherEndOf={(dep) => dep.predecessorId}
          nameOf={nameOf}
          keyOf={keyOf}
          locked={locked}
          onChangeType={(id, type) => updateLink(id, { type })}
          onChangeLag={(id, lagDays) => updateLink(id, { lagDays })}
          onRemove={removeLink}
          onSelect={selectTask}
        />

        <DependencyList
          title="Successors"
          dependencies={successors}
          otherEndOf={(dep) => dep.successorId}
          nameOf={nameOf}
          keyOf={keyOf}
          locked={locked}
          onChangeType={(id, type) => updateLink(id, { type })}
          onChangeLag={(id, lagDays) => updateLink(id, { lagDays })}
          onRemove={removeLink}
          onSelect={selectTask}
        />

        <div className="ganttor-section">
          <span className="ganttor-section__title">Outline</span>
          <div className="ganttor-row">
            <button
              type="button"
              className="ganttor-btn"
              onClick={() => outdentTask(task.id)}
              disabled={locked}
            >
              ⇤ Outdent
            </button>
            <button
              type="button"
              className="ganttor-btn"
              onClick={() => indentTask(task.id)}
              disabled={locked}
            >
              Indent ⇥
            </button>
            <button
              type="button"
              className="ganttor-btn"
              onClick={() => moveTaskUp(task.id)}
              disabled={locked}
            >
              ↑ Move up
            </button>
            <button
              type="button"
              className="ganttor-btn"
              onClick={() => moveTaskDown(task.id)}
              disabled={locked}
            >
              ↓ Move down
            </button>
          </div>
        </div>

        <div className="ganttor-field">
          <span className="ganttor-field__label">Comments</span>
          <textarea
            className="ganttor-textarea"
            value={task.notes ?? ''}
            placeholder="Notes for the team about this item…"
            disabled={locked}
            onChange={(event) => updateTask(task.id, { notes: event.target.value })}
          />
        </div>
      </div>
    </div>
  );
}

interface DependencyListProps {
  title: string;
  dependencies: Dependency[];
  otherEndOf: (dep: Dependency) => string;
  nameOf: (id: string) => string;
  keyOf: (id: string) => string | undefined;
  locked: boolean;
  onChangeType: (id: string, type: DepType) => void;
  onChangeLag: (id: string, lagDays: number) => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
}

function DependencyList({
  title,
  dependencies,
  otherEndOf,
  nameOf,
  keyOf,
  locked,
  onChangeType,
  onChangeLag,
  onRemove,
  onSelect,
}: DependencyListProps) {
  return (
    <div className="ganttor-section">
      <span className="ganttor-section__title">
        {title} ({dependencies.length})
      </span>
      {dependencies.length === 0 ? (
        <span className="ganttor-field__hint">
          None. Drag from the dot at a bar’s right edge onto another bar to add one.
        </span>
      ) : (
        dependencies.map((dep) => {
          const otherId = otherEndOf(dep);
          return (
            <div key={dep.id} className="ganttor-dep">
              <button
                type="button"
                className="ganttor-btn ganttor-btn--ghost ganttor-dep__name"
                onClick={() => onSelect(otherId)}
                title={nameOf(otherId)}
              >
                {keyOf(otherId) && <span className="ganttor-dep__key">{keyOf(otherId)}</span>}
                {nameOf(otherId)}
              </button>

              {/*
                * The name gets its own line above; type, lag and delete share this one.
                * Four non-shrinkable children on a single row could not fit the panel.
                */}
              <div className="ganttor-dep__controls">
                <select
                  className="ganttor-select"
                  value={dep.type}
                  disabled={locked}
                  aria-label={`Dependency type for ${nameOf(otherId)}`}
                  onChange={(event) => onChangeType(dep.id, event.target.value as DepType)}
                >
                  {DEP_TYPES.map((type) => (
                    <option key={type} value={type} title={DEP_TYPE_LABELS[type]}>
                      {type}
                    </option>
                  ))}
                </select>

                <input
                  type="number"
                  className="ganttor-input ganttor-input--num"
                  value={dep.lagDays}
                  disabled={locked}
                  aria-label={`Lag in days for ${nameOf(otherId)}`}
                  title="Working days of lag. Negative values overlap the tasks (a lead)."
                  onChange={(event) => onChangeLag(dep.id, clampInt(event.target.value, -365, 365))}
                />

                <button
                  type="button"
                  className="ganttor-btn ganttor-btn--ghost ganttor-btn--danger"
                  onClick={() => onRemove(dep.id)}
                  disabled={locked}
                  aria-label={`Remove dependency with ${nameOf(otherId)}`}
                >
                  ×
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function clampInt(raw: string, min: number, max: number): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
