/**
 * Project settings: the working calendar, the project start, and the import defaults.
 *
 * The calendar belongs here rather than buried in a menu because it changes every date
 * in the project — a team that works Sunday to Thursday gets a different schedule from
 * the same tasks, and that has to be a first-class setting rather than an assumption.
 */

import { useState } from 'react';

import type { WorkCalendar } from '@ganttor/gantt';

import { useProjectStore } from '../store/useProjectStore.js';

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const project = useProjectStore((s) => s.project);
  const setCalendar = useProjectStore((s) => s.setCalendar);
  const setProjectStart = useProjectStore((s) => s.setProjectStart);
  const setPointsToDays = useProjectStore((s) => s.setPointsToDays);
  const setDefaultDuration = useProjectStore((s) => s.setDefaultDuration);
  const resetToDemo = useProjectStore((s) => s.resetToDemo);

  const [holidayDraft, setHolidayDraft] = useState('');

  if (!open) return null;

  const { calendar } = project;

  const toggleWeekday = (index: number) => {
    // A calendar with no working day cannot schedule anything, so refuse the last one.
    if (calendar.workweek[index] && calendar.workweek.filter(Boolean).length === 1) return;
    const workweek = calendar.workweek.map((working, at) =>
      at === index ? !working : working,
    ) as unknown as WorkCalendar['workweek'];
    setCalendar({ ...calendar, workweek });
  };

  const addHoliday = () => {
    const value = holidayDraft.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || calendar.holidays.includes(value)) return;
    setCalendar({ ...calendar, holidays: [...calendar.holidays, value].sort() });
    setHolidayDraft('');
  };

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(4,6,10,0.62)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 50,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="ganttor-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Project settings"
        style={{ width: 'min(520px, 94vw)' }}
      >
        <div className="ganttor-dialog__head">
          <h2 className="ganttor-dialog__title">Project settings</h2>
          <button type="button" className="ganttor-btn ganttor-btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="ganttor-dialog__body">
          <label className="ganttor-field">
            <span className="ganttor-field__label">Project start</span>
            <input
              type="date"
              className="ganttor-input"
              value={project.startDate}
              onChange={(event) => {
                if (event.target.value) setProjectStart(event.target.value);
              }}
            />
            <span className="ganttor-field__hint">No task is scheduled before this date.</span>
          </label>

          <div className="ganttor-section">
            <span className="ganttor-section__title">Working week</span>
            <span className="ganttor-field__hint">
              Duration is counted in working days, so a five-day task never spans a
              non-working day.
            </span>
            <div className="ganttor-row" style={{ flexWrap: 'wrap' }}>
              {WEEKDAY_NAMES.map((name, index) => (
                <button
                  key={name}
                  type="button"
                  className="ganttor-btn"
                  aria-pressed={calendar.workweek[index]}
                  onClick={() => toggleWeekday(index)}
                >
                  {name.slice(0, 3)}
                </button>
              ))}
            </div>
          </div>

          <div className="ganttor-section">
            <span className="ganttor-section__title">
              Holidays ({calendar.holidays.length})
            </span>
            <div className="ganttor-row">
              <input
                type="date"
                className="ganttor-input"
                value={holidayDraft}
                aria-label="Holiday date"
                onChange={(event) => setHolidayDraft(event.target.value)}
              />
              <button type="button" className="ganttor-btn" onClick={addHoliday}>
                Add
              </button>
            </div>
            {calendar.holidays.length > 0 && (
              <div className="ganttor-row" style={{ flexWrap: 'wrap' }}>
                {calendar.holidays.map((holiday) => (
                  <button
                    key={holiday}
                    type="button"
                    className="ganttor-btn ganttor-btn--ghost"
                    title="Remove"
                    onClick={() =>
                      setCalendar({
                        ...calendar,
                        holidays: calendar.holidays.filter((h) => h !== holiday),
                      })
                    }
                  >
                    {holiday} ×
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="ganttor-section">
            <span className="ganttor-section__title">Import defaults</span>
            <div className="ganttor-grid2">
              <label className="ganttor-field">
                <span className="ganttor-field__label">Days per story point</span>
                <input
                  type="number"
                  min={0.25}
                  step={0.25}
                  className="ganttor-input ganttor-input--num"
                  value={project.settings.pointsToDays}
                  onChange={(event) =>
                    setPointsToDays(Math.max(0.25, Number(event.target.value) || 1))
                  }
                />
              </label>
              <label className="ganttor-field">
                <span className="ganttor-field__label">Default duration</span>
                <input
                  type="number"
                  min={1}
                  className="ganttor-input ganttor-input--num"
                  value={project.settings.defaultDurationDays}
                  onChange={(event) =>
                    setDefaultDuration(Math.max(1, Number(event.target.value) || 1))
                  }
                />
              </label>
            </div>
          </div>

          <div className="ganttor-section">
            <span className="ganttor-section__title">Danger zone</span>
            <button
              type="button"
              className="ganttor-btn ganttor-btn--danger"
              onClick={() => {
                resetToDemo();
                onClose();
              }}
            >
              Replace with the sample project
            </button>
            <span className="ganttor-field__hint">
              Discards the project currently open. Export first if you want to keep it.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
