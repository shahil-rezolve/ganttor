/**
 * The header, and the layout preferences it drives.
 *
 * These cover the complaints that were about *reachability* rather than about the
 * scheduler: the toolbar used to be one non-wrapping row of eighteen controls, roughly
 * 1500px of intrinsic width, so below about 1600px the controls on the right were simply
 * cut off — which is why the scale switcher appeared to be missing rather than merely
 * cramped, and why it seemed stuck on week view.
 *
 * jsdom does no layout, so these cannot assert that nothing is clipped at 1280px — that
 * is what the manual pass is for. What they *can* assert is the part a screenshot could
 * not tell you: that every control is present and reachable in the accessibility tree,
 * and that a chosen zoom outlives the store it was set on.
 */

import 'fake-indexeddb/auto';

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../App.js';
import { clearProject } from '../store/persistence.js';
import { deleteProjectById, listProjects } from '../store/projectRepository.js';
import { useAuthStore } from '../store/useAuthStore.js';
import { flushAutosave, useProjectStore } from '../store/useProjectStore.js';
import { readViewPrefs } from '../store/viewPrefs.js';

async function resetApp() {
  await act(async () => {
    await flushAutosave();
  });
  await clearProject();
  for (const summary of await listProjects()) await deleteProjectById(summary.id);
  localStorage.clear();
  act(() => {
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
      theme: 'dark',
    });
  });
}

beforeEach(resetApp);
afterEach(resetApp);

describe('every header control is reachable', () => {
  /*
   * The controls that must be directly operable without opening anything. The zoom units
   * are the point of the exercise: all four existed before and all four were unreachable
   * at a normal window width.
   */
  const ALWAYS_VISIBLE = [
    'Day',
    'Week',
    'Month',
    'Quarter',
    'Today',
    'Critical path',
    'Details',
    'Workload',
    'Baselines',
    '+ Task',
    '+ Project',
    'Refresh the project list',
    'View only',
    'Import Jira CSV',
  ];

  it.each(ALWAYS_VISIBLE)('offers %s as a button', (name) => {
    render(<App />);
    expect(screen.getByRole('button', { name })).toBeTruthy();
  });

  it('labels the project name and the two pickers', () => {
    render(<App />);
    expect(screen.getByLabelText('Project name')).toBeTruthy();
    expect(screen.getByLabelText('Open project')).toBeTruthy();
    expect(screen.getByLabelText('Colour bars by')).toBeTruthy();
  });

  it('groups the two segmented controls so they are distinguishable', () => {
    render(<App />);
    expect(screen.getByRole('group', { name: 'Time scale' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Side panel' })).toBeTruthy();
  });

  it('puts the rare and destructive actions behind one overflow menu', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Closed, they are absent — which is the point of moving them off the bar.
    expect(screen.queryByRole('menuitem', { name: /Delete project/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'More actions' }));

    for (const name of [/Undo/, /Redo/, /Export as JSON/, /Settings/, /theme/, /Delete project/]) {
      expect(screen.getByRole('menuitem', { name })).toBeTruthy();
    }
  });

  // A project opens view-only, so this button is how editing gets turned on at all.
  it('keeps the lock on the bar rather than in the menu, since it is a mode', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'View only' }));
    expect(screen.getByRole('button', { name: 'Editable' })).toBeTruthy();
  });
});

describe('the scale switcher', () => {
  it('marks exactly one unit as pressed', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Month' }));

    const pressed = ['Day', 'Week', 'Month', 'Quarter'].filter(
      (name) => screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true',
    );
    expect(pressed).toEqual(['Month']);
  });

  it('survives a reload', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Quarter' }));

    // What a fresh page load reads. `unit` used to live only in transient store state,
    // so it silently reverted to `week` here — the whole reason the switcher looked
    // stuck on week view.
    expect(readViewPrefs().unit).toBe('quarter');
  });

  it('does not mark the project dirty, since zoom is not a document change', async () => {
    const user = userEvent.setup();
    render(<App />);
    const before = useProjectStore.getState().project;

    await user.click(screen.getByRole('button', { name: 'Day' }));

    // Identity, not equality: routing zoom through the document would replace the object
    // and fire the debounced autosave on every click.
    expect(useProjectStore.getState().project).toBe(before);
  });
});

describe('the theme toggle', () => {
  it('flips the theme and remembers it', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Light theme/ }));

    expect(useProjectStore.getState().theme).toBe('light');
    expect(readViewPrefs().theme).toBe('light');
  });
});

describe('the splitters', () => {
  /** Reveal the detail panel, which is hidden at rest, so its splitter exists. */
  async function showPanel(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: /^Panel/ }));
  }

  it('exposes both as labelled separators a keyboard can reach', async () => {
    const user = userEvent.setup();
    render(<App />);
    await showPanel(user);

    const nameSplit = screen.getByRole('separator', { name: 'Resize the task name column' });
    const panelSplit = screen.getByRole('separator', { name: 'Resize the detail panel' });

    for (const splitter of [nameSplit, panelSplit]) {
      expect(splitter.getAttribute('aria-orientation')).toBe('vertical');
      expect(splitter.getAttribute('tabindex')).toBe('0');
    }
  });

  it('widens the name column with the arrow keys and persists the result', async () => {
    const user = userEvent.setup();
    render(<App />);

    const splitter = screen.getByRole('separator', { name: 'Resize the task name column' });
    const before = Number(splitter.getAttribute('aria-valuenow'));

    splitter.focus();
    await user.keyboard('{ArrowRight}');

    const after = Number(
      screen
        .getByRole('separator', { name: 'Resize the task name column' })
        .getAttribute('aria-valuenow'),
    );
    expect(after).toBeGreaterThan(before);
    expect(readViewPrefs().nameColumnWidth).toBe(after);
  });

  it('narrows the detail panel with the arrow keys and persists the result', async () => {
    const user = userEvent.setup();
    render(<App />);
    await showPanel(user);

    const splitter = screen.getByRole('separator', { name: 'Resize the detail panel' });
    const before = Number(splitter.getAttribute('aria-valuenow'));

    splitter.focus();
    // The panel is on the right, so ArrowRight moves the divider towards it.
    await user.keyboard('{ArrowRight}');

    const after = Number(
      screen
        .getByRole('separator', { name: 'Resize the detail panel' })
        .getAttribute('aria-valuenow'),
    );
    expect(after).toBeLessThan(before);
    expect(readViewPrefs().panelWidth).toBe(after);
  });

  /* The task list defaults to *expanded*: it is the outline, not a detail view. */
  it('collapses the task list and remembers it', async () => {
    const user = userEvent.setup();
    render(<App />);

    const button = screen.getByRole('button', { name: /List$/ });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.gantt__layout[data-grid-collapsed]')).toBeNull();

    await user.click(button);

    expect(
      screen.getByRole('button', { name: /List$/ }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(document.querySelector('.gantt__layout[data-grid-collapsed]')).toBeTruthy();
    expect(readViewPrefs().gridCollapsed).toBe(true);

    await user.click(screen.getByRole('button', { name: /List$/ }));
    expect(document.querySelector('.gantt__layout[data-grid-collapsed]')).toBeNull();
    expect(readViewPrefs().gridCollapsed).toBe(false);
  });

  /*
   * The detail panel defaults to *hidden* — it answers "tell me about this task", so at
   * rest the width belongs to the bars.
   */
  it('starts with the detail panel hidden and opens it from the toolbar', async () => {
    const user = userEvent.setup();
    render(<App />);

    const button = screen.getByRole('button', { name: /^Panel/ });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.ganttor-panel')).toBeNull();
    // The resize handle goes with it, or it would be a separator against nothing.
    expect(screen.queryByRole('separator', { name: 'Resize the detail panel' })).toBeNull();

    await user.click(button);

    expect(
      screen.getByRole('button', { name: /^Panel/ }).getAttribute('aria-pressed'),
    ).toBe('false');
    expect(document.querySelector('.ganttor-panel')).toBeTruthy();
    expect(readViewPrefs().panelCollapsed).toBe(false);

    await user.click(screen.getByRole('button', { name: /^Panel/ }));
    expect(document.querySelector('.ganttor-panel')).toBeNull();
    expect(readViewPrefs().panelCollapsed).toBe(true);
  });

  it('pops the detail panel open when a task is selected', async () => {
    render(<App />);
    expect(document.querySelector('.ganttor-panel')).toBeNull();

    act(() => useProjectStore.getState().selectTask('t-forward'));

    expect(document.querySelector('.ganttor-panel')).toBeTruthy();
  });

  /*
   * The reveal is not a stated preference. Persisting it would mean the first task
   * anyone ever clicked pinned the panel open for good, and "hidden by default" would
   * hold for exactly one session.
   */
  it('does not persist the pop-up, so the panel is hidden again next visit', async () => {
    render(<App />);
    act(() => useProjectStore.getState().selectTask('t-forward'));

    expect(document.querySelector('.ganttor-panel')).toBeTruthy();
    expect(readViewPrefs().panelCollapsed).toBe(true);
  });

  it('opens the panel when a different view is picked from the segmented control', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(document.querySelector('.ganttor-panel')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Workload' }));
    expect(document.querySelector('.ganttor-panel')).toBeTruthy();
  });

  it('clamps the name column instead of letting it collapse', async () => {
    const user = userEvent.setup();
    render(<App />);

    const splitter = screen.getByRole('separator', { name: 'Resize the task name column' });
    splitter.focus();
    // Far more than the range, so it has to land on the bound rather than pass it.
    await user.keyboard('{Shift>}{ArrowLeft>40/}{/Shift}');

    const width = Number(
      screen
        .getByRole('separator', { name: 'Resize the task name column' })
        .getAttribute('aria-valuenow'),
    );
    expect(width).toBeGreaterThan(0);
    expect(readViewPrefs().nameColumnWidth).toBe(width);
  });
});
