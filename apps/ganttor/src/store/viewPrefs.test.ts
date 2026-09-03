/**
 * View preferences.
 *
 * Two things are being pinned here. First, that zoom and theme actually *survive* — the
 * scale switcher looked broken because `unit` lived only in transient store state and
 * silently reverted to `week` on every reload. Second, that a bad stored value degrades
 * to the default instead of reaching the renderer: an invalid `unit` would index
 * `PX_PER_DAY` as `undefined` and take the whole axis out with a `NaN` width.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_VIEW_PREFS,
  NAME_COLUMN_MAX,
  NAME_COLUMN_MIN,
  PANEL_DEFAULT,
  PANEL_MAX,
  PANEL_MIN,
  readViewPrefs,
  writeViewPrefs,
} from './viewPrefs.js';

const KEY = 'ganttor:view-prefs';

beforeEach(() => {
  localStorage.clear();
});

describe('defaults', () => {
  it('falls back cleanly when nothing has been stored', () => {
    expect(readViewPrefs()).toEqual(DEFAULT_VIEW_PREFS);
  });

  it('leaves the name column unset, so the chart can auto-fit it', () => {
    expect(readViewPrefs().nameColumnWidth).toBeNull();
  });

  /*
   * The two collapse flags default in opposite directions, so neither can be validated
   * as "true unless stored otherwise" — each is compared against its own default.
   */
  it('opens with the task list showing and the detail panel put away', () => {
    expect(readViewPrefs().gridCollapsed).toBe(false);
    expect(readViewPrefs().panelCollapsed).toBe(true);
  });

  it('reads junk in either collapse flag as its default', () => {
    localStorage.setItem(KEY, JSON.stringify({ gridCollapsed: 'yes', panelCollapsed: 0 }));
    expect(readViewPrefs().gridCollapsed).toBe(false);
    expect(readViewPrefs().panelCollapsed).toBe(true);
  });

  it('still honours a stored flag set against its default', () => {
    writeViewPrefs({ gridCollapsed: true, panelCollapsed: false });
    expect(readViewPrefs().gridCollapsed).toBe(true);
    expect(readViewPrefs().panelCollapsed).toBe(false);
  });
});

describe('surviving a reload', () => {
  // A fresh `readViewPrefs()` is exactly what a new page load does.
  it('remembers the zoom unit', () => {
    writeViewPrefs({ unit: 'quarter' });
    expect(readViewPrefs().unit).toBe('quarter');
  });

  it('remembers the theme', () => {
    writeViewPrefs({ theme: 'light' });
    expect(readViewPrefs().theme).toBe('light');
  });

  it('remembers both splitter positions', () => {
    writeViewPrefs({ nameColumnWidth: 420, panelWidth: 500 });
    const prefs = readViewPrefs();
    expect(prefs.nameColumnWidth).toBe(420);
    expect(prefs.panelWidth).toBe(500);
  });

  it('merges rather than replacing, so one control cannot clear another', () => {
    writeViewPrefs({ unit: 'day' });
    writeViewPrefs({ theme: 'light' });
    expect(readViewPrefs()).toMatchObject({ unit: 'day', theme: 'light' });
  });

  it('does not touch the project document', () => {
    // Zoom is a view preference. Routing it through the document would mark the project
    // dirty and fire the debounced Supabase autosave on every zoom click.
    writeViewPrefs({ unit: 'month' });
    expect(Object.keys(localStorage)).toEqual([KEY]);
  });
});

describe('rejecting nonsense', () => {
  it('ignores an unknown zoom unit', () => {
    localStorage.setItem(KEY, JSON.stringify({ unit: 'fortnight' }));
    expect(readViewPrefs().unit).toBe(DEFAULT_VIEW_PREFS.unit);
  });

  it('ignores an unknown theme', () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: 'solarized' }));
    expect(readViewPrefs().theme).toBe(DEFAULT_VIEW_PREFS.theme);
  });

  it('survives malformed JSON', () => {
    localStorage.setItem(KEY, '{not json');
    expect(readViewPrefs()).toEqual(DEFAULT_VIEW_PREFS);
  });

  it('survives a JSON value that is not an object', () => {
    for (const raw of ['null', '42', '"week"', '[]']) {
      localStorage.setItem(KEY, raw);
      expect(readViewPrefs().unit).toBe(DEFAULT_VIEW_PREFS.unit);
    }
  });

  it('treats a non-numeric width as unset rather than as zero', () => {
    localStorage.setItem(KEY, JSON.stringify({ nameColumnWidth: 'wide', panelWidth: null }));
    const prefs = readViewPrefs();
    expect(prefs.nameColumnWidth).toBeNull();
    expect(prefs.panelWidth).toBe(PANEL_DEFAULT);
  });

  it('rejects NaN and Infinity, which would collapse the layout', () => {
    // `JSON.stringify` turns both into `null`, so write them past it deliberately.
    localStorage.setItem(KEY, '{"nameColumnWidth": 1e999, "panelWidth": 1e999}');
    const prefs = readViewPrefs();
    expect(prefs.nameColumnWidth).toBeNull();
    expect(prefs.panelWidth).toBe(PANEL_DEFAULT);
  });
});

describe('clamping', () => {
  it('clamps a stored name-column width into range', () => {
    localStorage.setItem(KEY, JSON.stringify({ nameColumnWidth: 5000 }));
    expect(readViewPrefs().nameColumnWidth).toBe(NAME_COLUMN_MAX);

    localStorage.setItem(KEY, JSON.stringify({ nameColumnWidth: -80 }));
    expect(readViewPrefs().nameColumnWidth).toBe(NAME_COLUMN_MIN);
  });

  it('clamps a stored panel width into range', () => {
    localStorage.setItem(KEY, JSON.stringify({ panelWidth: 9000 }));
    expect(readViewPrefs().panelWidth).toBe(PANEL_MAX);

    localStorage.setItem(KEY, JSON.stringify({ panelWidth: 10 }));
    expect(readViewPrefs().panelWidth).toBe(PANEL_MIN);
  });

  it('keeps a dragged-then-stored width stable across a reload', () => {
    // The width the splitter would have produced must come back unchanged, or the pane
    // would creep every time the app opened.
    writeViewPrefs({ nameColumnWidth: 380 });
    expect(readViewPrefs().nameColumnWidth).toBe(380);
    expect(readViewPrefs().nameColumnWidth).toBe(380);
  });
});
