/**
 * The resource workload view.
 *
 * A per-person strip of working days, coloured by how many concurrent tasks they are
 * carrying. The question this answers is the one CRITERIA asks — *is anyone
 * over-allocated* — so over-capacity days are the only thing given a loud colour, and
 * the worst-affected person sorts to the top.
 */

import { computeWorkload, toISO, type GanttView } from '@ganttor/gantt';

import { useProjectStore } from '../store/useProjectStore.js';

export interface WorkloadPanelProps {
  view: GanttView | null;
}

export function WorkloadPanel({ view }: WorkloadPanelProps) {
  const project = useProjectStore((s) => s.project);
  const selectTask = useProjectStore((s) => s.selectTask);

  if (!view) return null;

  const workload = computeWorkload(project, view.result, view.calendar);
  const overloaded = workload.resources.filter((r) => r.overAllocatedDays > 0);

  return (
    <div className="ganttor-panel">
      <div className="ganttor-panel__head">
        <span className="ganttor-panel__title">Resource workload</span>
        {overloaded.length > 0 && (
          <span className="ganttor-tag ganttor-tag--warn">
            {overloaded.length} over capacity
          </span>
        )}
      </div>

      <div className="ganttor-panel__body">
        {workload.resources.length === 0 ? (
          <div className="ganttor-empty">
            No assignees yet. Assign someone to a task to see their load here.
          </div>
        ) : (
          <>
            <span className="ganttor-field__hint">
              One cell per working day from {toISO(workload.from)} to {toISO(workload.to)}. Amber
              is at capacity, red is over.
            </span>

            <div className="ganttor-load">
              {workload.resources.map((resource) => {
                const byDay = new Map(resource.days.map((day) => [day.day, day]));

                return (
                  <div key={resource.resourceId} className="ganttor-load__person">
                    <div className="ganttor-load__name">
                      <strong>{resource.name}</strong>
                      <span className="ganttor-stat__value">
                        peak {resource.peakLoad}
                        {resource.capacity !== 1 ? ` / ${resource.capacity}` : ''}
                        {resource.overAllocatedDays > 0
                          ? ` · ${resource.overAllocatedDays}d over`
                          : ''}
                      </span>
                    </div>

                    <div className="ganttor-load__track">
                      {workingDaysBetween(workload.from, workload.to, view).map((day) => {
                        const cell = byDay.get(day);
                        const load = cell?.load ?? 0;
                        const level =
                          load === 0
                            ? 0
                            : load < resource.capacity
                              ? 1
                              : load === resource.capacity
                                ? 2
                                : 3;
                        return (
                          <span
                            key={day}
                            className="ganttor-load__cell"
                            data-level={level}
                            title={
                              cell
                                ? `${toISO(day)}: ${load} task(s)\n${cell.taskIds
                                    .map((id) => nameOf(project, id))
                                    .join('\n')}`
                                : `${toISO(day)}: free`
                            }
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {overloaded.length > 0 && (
              <div className="ganttor-section">
                <span className="ganttor-section__title">Overlapping work</span>
                {overloaded.map((resource) => {
                  const firstClash = resource.overAllocatedDayNums[0];
                  const clashing =
                    resource.days.find((day) => day.day === firstClash)?.taskIds ?? [];
                  return (
                    <div key={resource.resourceId} className="ganttor-section">
                      <span className="ganttor-field__hint">
                        {resource.name}, first clash on {firstClash ? toISO(firstClash) : '—'}:
                      </span>
                      {[...new Set(clashing)].map((taskId) => (
                        <button
                          key={taskId}
                          type="button"
                          className="ganttor-btn ganttor-btn--ghost"
                          onClick={() => selectTask(taskId)}
                        >
                          {nameOf(project, taskId)}
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}

            {workload.unknownAssigneeIds.length > 0 && (
              <span className="ganttor-field__hint">
                {workload.unknownAssigneeIds.length} assignee(s) on tasks have no resource
                record; they are shown by id.
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function nameOf(project: { tasks: { id: string; name: string; jiraKey?: string }[] }, id: string) {
  const task = project.tasks.find((t) => t.id === id);
  if (!task) return id;
  return task.jiraKey ? `${task.jiraKey} ${task.name}` : task.name;
}

/** Working days in a range, so a strip has no empty weekend cells to explain away. */
function workingDaysBetween(from: number, to: number, view: GanttView): number[] {
  const days: number[] = [];
  for (let day = from; day <= to; day++) {
    if (view.calendar.isWorkingDay(day)) days.push(day);
  }
  return days;
}
