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
import { clearProject } from './store/persistence.js';
import {
  deleteProjectById,
  listProjects,
  loadProjectById,
} from './store/projectRepository.js';
import { useAuthStore } from './store/useAuthStore.js';
import { flushAutosave, useProjectStore } from './store/useProjectStore.js';

/**
 * The stored project, whichever row autosave last wrote.
 *
 * The repository picks its backend at call time; with no Supabase credentials — which is
 * the case under vitest — that is the IndexedDB path, so this exercises the same code the
 * app runs, not a test-only shim.
 */
async function loadStoredProject() {
  const [latest] = await listProjects();
  return latest ? await loadProjectById(latest.id) : null;
}

/**
 * Reset the store between tests, since it is a module-level singleton.
 *
 * Every saved row has to go, not just the open one: projects now accumulate, and a
 * leftover row would be picked up by the next test's `hydrate()` in place of the sample.
 */
async function resetApp() {
  // Land any debounced write before wiping, so it cannot resurrect a row afterwards —
  // or update the store once the test that queued it has finished. Inside `act` because
  // the write reports back into the store, which re-renders a still-mounted toolbar.
  await act(async () => {
    await flushAutosave();
  });
  await clearProject();
  for (const summary of await listProjects()) {
    await deleteProjectById(summary.id);
  }
  act(() => {
    // Settle the auth gate up front. With no Supabase credentials `initialize()` reaches
    // the same state anyway; doing it synchronously keeps every render(<App />) below
    // from starting with an async state update React would flag as outside act().
    useAuthStore.setState({
      status: 'signed-in',
      userId: 'local',
      email: null,
      configured: false,
      error: null,
      busy: false,
    });
  });
  act(() => {
    useProjectStore.getState().resetToDemo();
    useProjectStore.setState({
      projectId: null,
      projects: [],
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

/** The task-grid row for a task, so cells can be found within it rather than by index. */
function gridRow(taskId: string): HTMLElement {
  const row = document.querySelector(`.gantt__grid-row[data-task-id="${taskId}"]`);
  if (!row) throw new Error(`No grid row for ${taskId}`);
  return row as HTMLElement;
}

describe('editing the chart in place', () => {
  it('renames a task from its grid cell', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    const field = within(gridRow('t-forward')).getByLabelText(/^Name of /);
    await user.clear(field);
    await user.type(field, 'Renamed in the grid');
    await user.tab();

    await waitFor(() =>
      expect(
        useProjectStore.getState().project.tasks.find((t) => t.id === 't-forward')?.name,
      ).toBe('Renamed in the grid'),
    );
  });

  /**
   * The point of editing through the engine rather than writing dates: a duration change
   * has to propagate along the dependency graph, not just redraw one bar.
   */
  it('changes a duration and the successors reschedule', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    const before = datesOf('t-forward');
    const field = within(gridRow('t-forward')).getByLabelText(/^Duration in days of /);
    await user.clear(field);
    await user.type(field, '9');
    await user.tab();

    await waitFor(() => {
      const task = schedule(useProjectStore.getState().project).tasks.get('t-forward')!;
      expect(task.durationDays).toBe(9);
    });
    // The bar got longer, and it did so by rescheduling rather than by moving.
    expect(datesOf('t-forward').startDay).toBe(before.startDay);
    expect(datesOf('t-forward').end).not.toBe(before.end);
  });

  it('moves a task by editing its start date, keeping its duration', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    const before = datesOf('t-forward');
    const durationBefore = schedule(useProjectStore.getState().project).tasks.get(
      't-forward',
    )!.durationDays;

    const later = toISO(before.startDay + 7);
    const field = within(gridRow('t-forward')).getByLabelText(/^Start date of /);
    await user.clear(field);
    await user.type(field, later);
    await user.tab();

    await waitFor(() => expect(datesOf('t-forward').startDay).toBeGreaterThan(before.startDay));
    expect(
      schedule(useProjectStore.getState().project).tasks.get('t-forward')!.durationDays,
    ).toBe(durationBefore);
  });

  /**
   * A summary's numbers are rolled up from its children. Offering an input there would
   * invite an edit the scheduler must immediately overwrite.
   */
  it('offers no duration input on a summary row', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    const summary = within(gridRow('e-engine'));
    expect(summary.queryByLabelText(/^Duration in days of /)).toBeNull();
    // Its name is still editable — only the derived numbers are not.
    expect(summary.getByLabelText(/^Name of /)).toBeTruthy();
  });

  it('adds a task from a row control and deletes it again', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    const before = useProjectStore.getState().project.tasks.length;
    await user.click(within(gridRow('t-forward')).getByLabelText(/^Add a task below /));

    await waitFor(() =>
      expect(useProjectStore.getState().project.tasks.length).toBe(before + 1),
    );

    const added = useProjectStore.getState().selectedTaskId!;
    await user.click(within(gridRow(added)).getByLabelText(/^Delete /));
    await waitFor(() => expect(useProjectStore.getState().project.tasks.length).toBe(before));
  });

  it('turns the cells back into plain text when the project is view-only', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());
    expect(within(gridRow('t-forward')).getByLabelText(/^Name of /)).toBeTruthy();

    act(() => useProjectStore.getState().toggleLock());

    await waitFor(() =>
      expect(within(gridRow('t-forward')).queryByLabelText(/^Name of /)).toBeNull(),
    );
  });
});

describe('multiple projects', () => {
  it('keeps an import as a new project instead of overwriting the open one', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());

    // Let the sample project's autosave land, so there is something to overwrite.
    await waitFor(async () => expect((await listProjects()).length).toBe(1), { timeout: 3000 });
    const [sample] = await listProjects();

    act(() => {
      useProjectStore.getState().loadProjectDocument(
        { ...useProjectStore.getState().project, name: 'Imported from Jira', tasks: [] },
        'Imported.',
      );
    });

    await waitFor(async () => expect((await listProjects()).length).toBe(2), { timeout: 3000 });

    // The original is still there, under its own name and with its tasks intact.
    const kept = await loadProjectById(sample!.id);
    expect(kept?.project.tasks.length).toBeGreaterThan(0);
  });

  it('switches between stored projects', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());
    await waitFor(async () => expect((await listProjects()).length).toBe(1), { timeout: 3000 });
    const [sample] = await listProjects();

    act(() => useProjectStore.getState().createNewProject());
    await waitFor(async () => expect((await listProjects()).length).toBe(2), { timeout: 3000 });
    expect(useProjectStore.getState().project.tasks).toHaveLength(0);

    await act(async () => {
      await useProjectStore.getState().switchProject(sample!.id);
    });
    expect(useProjectStore.getState().project.tasks.length).toBeGreaterThan(0);
  });

  /**
   * Autosave is debounced by 400ms, so an edit made immediately before an import is still
   * queued when the open document is replaced. It has to be written to the project it was
   * made in — not dropped when the queue is overwritten, and not redirected into the
   * project that replaced it.
   */
  it('writes an edit queued just before an import into the original project', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('bar-t-forward')).toBeTruthy());
    await waitFor(async () => expect((await listProjects()).length).toBe(1), { timeout: 3000 });
    const [sample] = await listProjects();

    // Edit, then import straight away — well inside the debounce window.
    act(() => {
      useProjectStore.getState().updateTask('t-forward', { name: 'Typed just before import' });
      useProjectStore.getState().loadProjectDocument(
        { ...useProjectStore.getState().project, name: 'Imported', tasks: [] },
        'Imported.',
      );
    });

    await act(async () => {
      await flushAutosave();
    });

    // The edit reached the project it was made in.
    const original = await loadProjectById(sample!.id);
    expect(original?.project.tasks.find((t) => t.id === 't-forward')?.name).toBe(
      'Typed just before import',
    );
    // And the import did not land on top of it.
    expect(original?.project.name).not.toBe('Imported');
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
        const stored = await loadStoredProject();
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
      async () => expect((await loadStoredProject())?.project).toBeTruthy(),
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

