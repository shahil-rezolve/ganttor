/**
 * Baseline management: save a snapshot, choose which one to compare against, and see
 * the slip against it.
 *
 * The list is sorted worst-slip first, because the reason to open this panel is to find
 * out what has moved.
 */

import { computeVariance, toISO, totalSlip, type GanttView } from '@ganttor/gantt';

import { useProjectStore } from '../store/useProjectStore.js';

export interface BaselinePanelProps {
  view: GanttView | null;
}

export function BaselinePanel({ view }: BaselinePanelProps) {
  const project = useProjectStore((s) => s.project);
  const saveBaseline = useProjectStore((s) => s.saveBaseline);
  const removeBaseline = useProjectStore((s) => s.removeBaseline);
  const setActiveBaseline = useProjectStore((s) => s.setActiveBaseline);
  const toggleBaselineOverlay = useProjectStore((s) => s.toggleBaselineOverlay);
  const selectTask = useProjectStore((s) => s.selectTask);

  if (!view) return null;

  const { baseline, result, calendar } = view;

  const slipped = baseline
    ? [...result.tasks.values()]
        .filter((task) => task.kind !== 'summary')
        .map((task) => ({
          task,
          variance: computeVariance(calendar, baseline.bars[task.id], task),
        }))
        .filter((entry) => entry.variance && entry.variance.endDelta !== 0)
        .sort((a, b) => (b.variance?.endDelta ?? 0) - (a.variance?.endDelta ?? 0))
    : [];

  return (
    <div className="ganttor-panel">
      <div className="ganttor-panel__head">
        <span className="ganttor-panel__title">Baselines</span>
        <button
          type="button"
          className="ganttor-btn ganttor-btn--primary"
          onClick={() => saveBaseline()}
          disabled={project.settings.locked}
        >
          Save current
        </button>
      </div>

      <div className="ganttor-panel__body">
        {project.baselines.length === 0 ? (
          <div className="ganttor-empty">
            No baselines yet. Save one to freeze today’s schedule, then compare against it as
            work moves.
          </div>
        ) : (
          <>
            <div className="ganttor-section">
              <span className="ganttor-section__title">Compare against</span>
              <select
                className="ganttor-select"
                value={project.activeBaselineId ?? ''}
                aria-label="Active baseline"
                onChange={(event) => setActiveBaseline(event.target.value || null)}
              >
                <option value="">None</option>
                {project.baselines.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} · {new Date(entry.savedAt).toLocaleDateString()}
                  </option>
                ))}
              </select>

              <div className="ganttor-row ganttor-row--split">
                <button
                  type="button"
                  className="ganttor-btn"
                  aria-pressed={project.settings.showBaseline}
                  onClick={toggleBaselineOverlay}
                >
                  Show ghost bars
                </button>
                {project.activeBaselineId && (
                  <button
                    type="button"
                    className="ganttor-btn ganttor-btn--ghost ganttor-btn--danger"
                    onClick={() => removeBaseline(project.activeBaselineId!)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>

            {baseline && (
              <div className="ganttor-section">
                <span className="ganttor-section__title">Variance</span>
                <div className="ganttor-stat">
                  <span className="ganttor-stat__label">Saved</span>
                  <span className="ganttor-stat__value">
                    {new Date(baseline.savedAt).toLocaleString()}
                  </span>
                </div>
                <div className="ganttor-stat">
                  <span className="ganttor-stat__label">Total slip</span>
                  <span className="ganttor-stat__value ganttor-stat__value--critical">
                    {totalSlip(calendar, baseline, result)}d
                  </span>
                </div>
                <div className="ganttor-stat">
                  <span className="ganttor-stat__label">Tasks moved</span>
                  <span className="ganttor-stat__value">{slipped.length}</span>
                </div>
              </div>
            )}

            {slipped.length > 0 && (
              <div className="ganttor-section">
                <span className="ganttor-section__title">What moved</span>
                <div className="ganttor-table__scroll">
                  <table className="ganttor-table">
                    <thead>
                      <tr>
                        <th>Task</th>
                        <th>Was</th>
                        <th>Now</th>
                        <th>Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {slipped.map(({ task, variance }) => {
                        const bar = baseline?.bars[task.id];
                        return (
                          <tr key={task.id}>
                            <td>
                              <button
                                type="button"
                                className="ganttor-btn ganttor-btn--ghost"
                                onClick={() => selectTask(task.id)}
                              >
                                {nameOf(project, task.id)}
                              </button>
                            </td>
                            <td className="num">{bar ? toISO(bar.end) : '—'}</td>
                            <td className="num">{toISO(task.end)}</td>
                            <td
                              className="num"
                              style={{
                                color:
                                  (variance?.endDelta ?? 0) > 0
                                    ? 'var(--gantt-critical)'
                                    : 'var(--gantt-status-on-track)',
                              }}
                            >
                              {signed(variance?.endDelta ?? 0)}d
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
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
  return task.jiraKey ?? task.name;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
