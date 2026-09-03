/**
 * View preferences, persisted per browser.
 *
 * Zoom, theme, and the two splitter positions describe *how you are looking at* a
 * project, not the project itself. They deliberately do not live in `project.settings`:
 * routing them through the document would mark it dirty and fire the 400ms Supabase
 * autosave on every zoom click, and a shared project would then drag one person's zoom
 * level onto everyone else.
 *
 * Every read is validated rather than trusted. A stale or hand-edited value must degrade
 * to the default, because a bad `unit` would reach `PX_PER_DAY[unit]` as `undefined` and
 * take the whole axis out with a `NaN` width.
 */

import { SCALE_UNITS, type ScaleUnit } from '@ganttor/gantt';

const KEY = 'ganttor:view-prefs';

export interface ViewPrefs {
  unit: ScaleUnit;
  theme: 'dark' | 'light';
  /** Width of the WBS name column in px. `null` means "auto-fit to the content". */
  nameColumnWidth: number | null;
  /** Width of the detail panel in px. */
  panelWidth: number;
  /**
   * The project this browser last had open, so a reload reopens *your* work.
   *
   * The workspace is shared, so "most recently touched" now means whatever anyone edited
   * last — without this, signing in could drop you into a colleague's project. `null`
   * falls back to that behaviour, which is still right for a first visit.
   */
  lastProjectId: string | null;
  /** The left-hand WBS pane is hidden, giving the whole width to the bars. */
  gridCollapsed: boolean;
  /**
   * The right-hand detail panel is hidden.
   *
   * Defaults to `true`: the panel is a *response* to picking a task, so at rest the
   * width belongs to the bars. Clicking a task pops it open, and that reveal is
   * deliberately never written back here — otherwise the first click any user ever made
   * would pin the panel open forever and "hidden by default" would hold for exactly one
   * session. Only the toolbar toggle states a preference, so only it persists.
   */
  panelCollapsed: boolean;
}

export const NAME_COLUMN_MIN = 160;
export const NAME_COLUMN_MAX = 720;
export const PANEL_MIN = 260;
export const PANEL_MAX = 720;
export const PANEL_DEFAULT = 360;

export const DEFAULT_VIEW_PREFS: ViewPrefs = {
  unit: 'week',
  theme: 'dark',
  nameColumnWidth: null,
  panelWidth: PANEL_DEFAULT,
  lastProjectId: null,
  gridCollapsed: false,
  panelCollapsed: true,
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Read the stored preferences, falling back to defaults field by field.
 *
 * Wrapped in try/catch because `localStorage` *throws* rather than returning null in a
 * browser configured to block site data — a crash on first paint would be an odd way to
 * report that someone declined cookies.
 */
export function readViewPrefs(): ViewPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return DEFAULT_VIEW_PREFS;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_VIEW_PREFS;
    const record = parsed as Record<string, unknown>;

    const unit = SCALE_UNITS.includes(record['unit'] as ScaleUnit)
      ? (record['unit'] as ScaleUnit)
      : DEFAULT_VIEW_PREFS.unit;

    const theme = record['theme'] === 'light' || record['theme'] === 'dark'
      ? record['theme']
      : DEFAULT_VIEW_PREFS.theme;

    const storedName = record['nameColumnWidth'];
    const nameColumnWidth =
      typeof storedName === 'number' && Number.isFinite(storedName)
        ? clamp(storedName, NAME_COLUMN_MIN, NAME_COLUMN_MAX)
        : null;

    const storedPanel = record['panelWidth'];
    const panelWidth =
      typeof storedPanel === 'number' && Number.isFinite(storedPanel)
        ? clamp(storedPanel, PANEL_MIN, PANEL_MAX)
        : PANEL_DEFAULT;

    const storedLast = record['lastProjectId'];
    const lastProjectId = typeof storedLast === 'string' && storedLast ? storedLast : null;

    // Strict comparison against the *default*, so junk — absent, a string, a stale
    // number — reads as the state a first-time visitor should land in: the grid open,
    // the detail panel put away.
    const gridCollapsed = record['gridCollapsed'] === true;
    const panelCollapsed = record['panelCollapsed'] !== false;

    return {
      unit,
      theme,
      nameColumnWidth,
      panelWidth,
      lastProjectId,
      gridCollapsed,
      panelCollapsed,
    };
  } catch {
    return DEFAULT_VIEW_PREFS;
  }
}

/** Merge a patch into the stored preferences. Failure to persist is never fatal. */
export function writeViewPrefs(patch: Partial<ViewPrefs>): void {
  try {
    const next = { ...readViewPrefs(), ...patch };
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full or blocked store costs the user their zoom level, not their work.
  }
}
