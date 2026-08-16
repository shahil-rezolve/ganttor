/**
 * End-to-end tests through the real app.
 *
 * Everything here goes through `App` with the real store, the real engine, and the real
 * IndexedDB path (via `fake-indexeddb`) — no mocked scheduler. These are the checks a
 * screenshot could not give: that dragging a bar actually reschedules its successors and
 * the change survives a reload, that a rejected cycle names the tickets involved, and
 * that CRITERIA's update-cadence requirement holds — editing progress must not require
 * rebuilding anything.
 */

import 'fake-indexeddb/auto';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compileCalendar, schedule, toISO } from '@ganttor/gantt';

import { App } from './App.js';
import { clearProject, loadProject } from './store/persistence.js';
import { useProjectStore } from './store/useProjectStore.js';

/** Reset the store between tests, since it is a module-level singleton. */
async function resetApp() {
  await clearProject();
  act(() => {
    useProjectStore.getState().resetToDemo();
    useProjectStore.setState({
      selectedTaskId: null,
      selectedDependencyId: null,
      notice: null,
      loading: false,
      past: [],
      future: [],
      unit: 'week',
    });
  });
}

beforeEach(resetApp);
afterEach(resetApp);

/** Dates the engine currently produces for a task, straight from the store. */
function datesOf(taskId: string) {
  const project = useProjectStore.getState().project;
  const task = schedule(project).tasks.get(taskId)!;
  return { start: toISO(task.start), end: toISO(task.end), startDay: task.start };
}

/**
 * Working days a task's start moved, measured with the project's own calendar rather
 * than a hand-rolled weekday count — the engine's holiday list has to be honoured or
 * the expectation would drift from what the scheduler actually did.
 */
function workingDaysMoved(fromDay: number, toDay: number): number {
  const calendar = compileCalendar(useProjectStore.getState().project.calendar);
  return calendar.workingDayDelta(fromDay, toDay);
}

describe('first run', () => {
  it('renders the sample project as a chart', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    // A row per task, arrows, milestones, and a today marker where applicable.
    expect(screen.getByTestId('milestone-m-ship')).toBeTruthy();
    expect(screen.getByTestId('summary-e-engine')).toBeTruthy();
    expect(document.querySelectorAll('[data-dependency-id]').length).toBeGreaterThan(20);
  });

  it('shows the legend for the active colour dimension', async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    const legend = container.querySelector('.ganttor-legend')!;
    expect(within(legend as HTMLElement).getByText('On track')).toBeTruthy();
    expect(within(legend as HTMLElement).getByText('At risk')).toBeTruthy();
    // The critical-path swatch is part of the legend, not of the colour dimension.
    expect(within(legend as HTMLElement).getByText('Critical path')).toBeTruthy();
  });

  it('reports no circular dependencies in the sample project', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('rescheduling propagates', () => {
  // CRITERIA: "Shift a predecessor → all successors reschedule correctly per dependency
  // type." Driven through the store the way the drag handler drives it.
  it('moves finish-to-start successors by the same number of days', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-calendar')).toBeTruthy());

    const before = {
      calendar: datesOf('t-calendar'),
      forward: datesOf('t-forward'),
      cpm: datesOf('t-cpm'),
    };

    // t-calendar → t-forward → t-cpm is a finish-to-start chain in the sample project.
    const scheduled = schedule(useProjectStore.getState().project).tasks.get('t-calendar')!;
    act(() => {
      useProjectStore.getState().applyDates('t-calendar', {
        start: scheduled.start + 7, // one calendar week later
        end: scheduled.end + 7,
        durationDays: scheduled.durationDays,
      });
    });

    const after = {
      calendar: datesOf('t-calendar'),
      forward: datesOf('t-forward'),
      cpm: datesOf('t-cpm'),
    };

    // One calendar week is five working days, and that delay must appear on every
    // downstream task in the chain — not just the immediate successor.
    const delay = workingDaysMoved(before.calendar.startDay, after.calendar.startDay);
    expect(delay).toBe(5);
    expect(workingDaysMoved(before.forward.startDay, after.forward.startDay)).toBe(delay);
    expect(workingDaysMoved(before.cpm.startDay, after.cpm.startDay)).toBe(delay);
  });

  it('holds a dragged bar in place across a re-render', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-theme')).toBeTruthy());

    const scheduled = schedule(useProjectStore.getState().project).tasks.get('t-theme')!;
    const target = scheduled.start + 14;

    act(() => {
      useProjectStore.getState().applyDates('t-theme', {
        start: target,
        end: target + (scheduled.end - scheduled.start),
        durationDays: scheduled.durationDays,
      });
    });

    const pinned = datesOf('t-theme');
    // Re-render and confirm it has not sprung back to its earliest possible date.
    act(() => {
      useProjectStore.getState().setUnit('day');
    });
    expect(datesOf('t-theme')).toEqual(pinned);
  });

  it('undoes and redoes a reschedule', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-calendar')).toBeTruthy());

    const original = datesOf('t-forward');
    const scheduled = schedule(useProjectStore.getState().project).tasks.get('t-calendar')!;

    act(() => {
      useProjectStore.getState().applyDates('t-calendar', {
        start: scheduled.start + 7,
        end: scheduled.end + 7,
        durationDays: scheduled.durationDays,
      });
    });
    expect(datesOf('t-forward')).not.toEqual(original);

    act(() => useProjectStore.getState().undo());
    expect(datesOf('t-forward')).toEqual(original);

    act(() => useProjectStore.getState().redo());
    expect(datesOf('t-forward')).not.toEqual(original);
  });
});

describe('circular dependencies are refused', () => {
  // CRITERIA: "Attempt A→B→C→A link; app should block or warn."
  it('rejects the link, names the tickets, and writes nothing', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    const before = useProjectStore.getState().project.dependencies.length;

    // t-calendar → t-forward already exists, so the reverse closes a loop.
    act(() => {
      useProjectStore.getState().createLink('t-forward', 't-calendar');
    });

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toMatch(/circular/i);
    // The message names the actual issues, which is the actionable part.
    expect(notice.textContent).toContain('GNT-12');
    expect(notice.textContent).toContain('GNT-13');
    expect(useProjectStore.getState().project.dependencies).toHaveLength(before);
  });

  it('accepts a link that merely converges', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    const before = useProjectStore.getState().project.dependencies.length;
    act(() => {
      useProjectStore.getState().createLink('t-grid', 't-cpm');
    });
    expect(useProjectStore.getState().project.dependencies).toHaveLength(before + 1);
  });
});

describe('daily progress updates', () => {
  // CRITERIA: "the app should make it trivial to update progress daily ... not require
  // rebuilding the chart from scratch."
  it('changes the bar fill without touching the schedule', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    const datesBefore = datesOf('t-forward');
    const width = Number.parseFloat(screen.getByTestId('bar-t-forward').style.width);

    act(() => {
      useProjectStore.getState().updateTask('t-forward', { percentComplete: 60 });
    });

    await waitFor(() => {
      const remaining = Number.parseFloat(
        screen.getByTestId('remaining-t-forward').style.width,
      );
      expect(remaining).toBeCloseTo(width * 0.4, 1);
    });
    // Progress is not a scheduling input, so nothing may move.
    expect(datesOf('t-forward')).toEqual(datesBefore);
  });

  it('rolls child progress up onto the summary bar', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('summary-e-chart')).toBeTruthy());

    act(() => {
      for (const id of ['t-grid', 't-timeline', 't-bars', 't-arrows', 't-drag', 't-theme']) {
        useProjectStore.getState().updateTask(id, { percentComplete: 100 });
      }
    });

    const view = schedule(useProjectStore.getState().project);
    expect(view.tasks.get('e-chart')!.percentComplete).toBe(100);
  });
});

describe('zoom', () => {
  /*
   * Bars are laid out on the *calendar* axis while durations count working days, so a
   * six-working-day task that spans a weekend is eight columns wide. The invariant to
   * check is therefore width ÷ calendar-span — constant for every bar at a given zoom,
   * and identical in ratio across zooms.
   */
  it('keeps every bar proportional to its calendar span at every scale', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    const result = schedule(useProjectStore.getState().project);
    const ids = ['t-forward', 't-cycles', 't-cpm', 't-grid', 't-drag'];

    for (const label of ['Day', 'Week', 'Month', 'Quarter']) {
      await user.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

      const perDay = ids.map((id) => {
        const task = result.tasks.get(id)!;
        const span = task.end - task.start + 1; // calendar days
        const width = Number.parseFloat(screen.getByTestId(`bar-${id}`).style.width);
        return width / span;
      });

      // One pixels-per-day figure governs every bar at this zoom.
      for (const value of perDay) {
        expect(value, `${label} zoom`).toBeCloseTo(perDay[0]!, 6);
      }
    }
  });

  it('reaches the same dates at every zoom, since zoom is a view concern', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    const dates = datesOf('t-forward');
    for (const label of ['Day', 'Month', 'Quarter', 'Week']) {
      await user.click(screen.getByRole('button', { name: label }));
      expect(datesOf('t-forward')).toEqual(dates);
    }
  });
});

describe('baselines', () => {
  // CRITERIA: "Edit a task after baseline save; original baseline bar remains unchanged."
  it('keeps the saved snapshot fixed while the live schedule moves', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-calendar')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Baselines' }));
    await user.click(screen.getByRole('button', { name: 'Save current' }));

    const baseline = useProjectStore.getState().project.baselines[0]!;
    const snapshot = { ...baseline.bars['t-forward']! };

    const scheduled = schedule(useProjectStore.getState().project).tasks.get('t-calendar')!;
    act(() => {
      useProjectStore.getState().applyDates('t-calendar', {
        start: scheduled.start + 14,
        end: scheduled.end + 14,
        durationDays: scheduled.durationDays,
      });
    });

    // The live task has moved…
    const live = schedule(useProjectStore.getState().project).tasks.get('t-forward')!;
    expect(live.start).toBeGreaterThan(snapshot.start);
    // …and the baseline has not.
    expect(useProjectStore.getState().project.baselines[0]!.bars['t-forward']).toEqual(snapshot);

    // The ghost bar is drawn at the promised dates.
    await waitFor(() => expect(screen.getByTestId('baseline-t-forward')).toBeTruthy());
    expect(screen.getByText(/Total slip/)).toBeTruthy();
  });
});

describe('view-only lock', () => {
  it('disables editing without hiding anything', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Editable' }));

    expect(screen.getByRole('button', { name: 'View only' })).toBeTruthy();
    expect(screen.getByTestId('bar-t-forward').dataset.locked).toBe('true');
    expect(document.querySelector('.gantt__handle')).toBeNull();
    // The chart itself is untouched — locking is about editing, not visibility.
    expect(document.querySelectorAll('[data-dependency-id]').length).toBeGreaterThan(20);
  });
});

describe('the workload view', () => {
  it('flags the over-allocated engineer in the sample project', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Workload' }));

    const panel = screen
      .getByText('Resource workload')
      .closest<HTMLElement>('.ganttor-panel')!;
    // Lena carries the engine chain and is deliberately double-booked in the sample.
    expect(within(panel).getByText('Lena Brandt')).toBeTruthy();
    expect(within(panel).getByText(/over capacity/)).toBeTruthy();
  });
});

describe('the task detail panel', () => {
  it('shows derived dates and float for the selected task', async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-cpm')).toBeTruthy());

    act(() => useProjectStore.getState().selectTask('t-cpm'));

    const panel = await waitFor(() => {
      const found = container.querySelector('.ganttor-panel');
      expect(found?.textContent).toContain('GNT-15');
      return found as HTMLElement;
    });

    expect(within(panel).getByText('Total float')).toBeTruthy();
    // The dates shown are the engine's output, not stored fields.
    expect(within(panel).getByText(datesOf('t-cpm').start)).toBeTruthy();
    expect(within(panel).getByText(datesOf('t-cpm').end)).toBeTruthy();
  });

  it('edits a dependency’s type and lag, and the schedule follows', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    // d-6 is t-calendar → t-forward, finish-to-start with no lag.
    const before = datesOf('t-forward');
    act(() => useProjectStore.getState().updateLink('d-6', { lagDays: 3 }));
    expect(workingDaysMoved(before.startDay, datesOf('t-forward').startDay)).toBe(3);

    // Start-to-start with no lag aligns it with its predecessor's start instead.
    act(() => useProjectStore.getState().updateLink('d-6', { type: 'SS', lagDays: 0 }));
    expect(datesOf('t-forward').start).toBe(datesOf('t-calendar').start);

    // Finish-to-finish aligns the finishes.
    act(() => useProjectStore.getState().updateLink('d-6', { type: 'FF', lagDays: 0 }));
    expect(datesOf('t-forward').end).toBe(datesOf('t-calendar').end);
  });
});

describe('persistence', () => {
  it('autosaves an edit and reloads it', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    act(() => {
      useProjectStore.getState().updateTask('t-forward', { name: 'Renamed by the test' });
    });

    // Autosave is debounced, so wait for the write rather than assuming it happened.
    await waitFor(
      async () => {
        const stored = await loadProject();
        expect(stored?.project.tasks.find((t) => t.id === 't-forward')?.name).toBe(
          'Renamed by the test',
        );
      },
      { timeout: 3000 },
    );
  });

  it('opens the autosaved project on the next visit', async () => {
    act(() => {
      useProjectStore.getState().updateTask('t-forward', { name: 'From a previous session' });
    });
    await waitFor(
      async () => expect((await loadProject())?.project).toBeTruthy(),
      { timeout: 3000 },
    );

    // A fresh mount must read what was stored, not fall back to the sample.
    act(() => useProjectStore.setState({ loading: true }));
    render(<App />);

    await waitFor(() =>
      expect(useProjectStore.getState().project.tasks.find((t) => t.id === 't-forward')?.name).toBe(
        'From a previous session',
      ),
    );
  });
});

