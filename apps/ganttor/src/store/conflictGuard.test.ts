/**
 * The conflict guard on autosave.
 *
 * The workspace is shared, so two people can hold the same document open. Autosave writes
 * the *whole* document, which means a stale tab's write would silently discard everything
 * the other person did. `saveProjectById` therefore carries the `updated_at` it last read
 * and the server refuses the update if the row has moved; this file pins what the store
 * does with that refusal.
 *
 * ── Why this one file mocks ─────────────────────────────────────────────────────────
 * The suite avoids mocks on principle — everything else drives the real store against a
 * real (fake-indexeddb) backend. It cannot here: a conflict needs *two* writers, and
 * vitest has one backend with one. The IndexedDB branch has no precondition at all (one
 * browser, one writer) and `vite.config.ts` blanks the Supabase env vars so the Postgres
 * branch never runs under test. So `saveProjectById` is stubbed — and only it; everything
 * else in the repository module stays real — to produce the outcome the server would.
 *
 * What that buys is coverage of the part that is actually easy to get wrong: the store's
 * handling of each outcome, and the token it threads into the *next* write.
 */

import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SaveOutcome } from './projectRepository.js';

// `vi.hoisted`, because `vi.mock` factories run during import evaluation — a plain `const`
// declared below would still be in its temporal dead zone when the factory reaches for it.
const { saveMock } = vi.hoisted(() => ({ saveMock: vi.fn() }));

vi.mock('./projectRepository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projectRepository.js')>();
  return { ...actual, saveProjectById: saveMock };
});

const { flushAutosave, useProjectStore } = await import('./useProjectStore.js');

const FIRST = '2026-08-31T09:00:00.000000+00:00';
const THEIRS = '2026-08-31T09:00:04.000000+00:00';

const saved = (savedAt: string): SaveOutcome => ({ kind: 'saved', id: 'p1', savedAt });

/** The `expectedSavedAt` argument of the n-th write. */
function tokenOfCall(index: number): string | null {
  return saveMock.mock.calls[index]?.[2] as string | null;
}

beforeEach(async () => {
  saveMock.mockReset();
  saveMock.mockResolvedValue(saved(FIRST));

  // `resetToDemo` is the only public way to clear the module-level open-document ref, and
  // it queues a save — so let that one land, and start each test from a saved document.
  useProjectStore.getState().resetToDemo();
  await flushAutosave();

  useProjectStore.setState({ notice: null });
  saveMock.mockReset();
});

describe('a save refused because the row moved', () => {
  it('reports it, and names the way to keep the work', async () => {
    saveMock.mockResolvedValue({ kind: 'conflict', id: 'p1', savedAt: THEIRS });

    useProjectStore.getState().renameProject('Mine');
    await flushAutosave();

    const { notice, remoteConflict } = useProjectStore.getState();
    expect(remoteConflict).toBe(true);
    expect(notice?.tone).toBe('error');
    // The wording is load-bearing: halting autosave reads as a bug without an escape hatch.
    expect(notice?.message).toMatch(/Someone else saved this project/);
    expect(notice?.message).toMatch(/Export as JSON/);
  });

  it('halts autosave rather than retrying with a spent token', async () => {
    saveMock.mockResolvedValue({ kind: 'conflict', id: 'p1', savedAt: THEIRS });

    useProjectStore.getState().renameProject('Mine');
    await flushAutosave();
    expect(saveMock).toHaveBeenCalledTimes(1);

    saveMock.mockClear();
    useProjectStore.getState().renameProject('Mine again');
    await flushAutosave();

    // A retry could only fail the same way, once per keystroke. The edit stays on screen.
    expect(saveMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().project.name).toBe('Mine again');
  });

  it('leaves the last known server timestamp alone, so nothing claims to be saved', async () => {
    saveMock.mockResolvedValue({ kind: 'conflict', id: 'p1', savedAt: THEIRS });

    useProjectStore.getState().renameProject('Mine');
    await flushAutosave();

    expect(useProjectStore.getState().lastSavedAt).toBe(FIRST);
  });
});

describe('a save against a row that is gone', () => {
  it('says so, and halts autosave the same way', async () => {
    saveMock.mockResolvedValue({ kind: 'gone', id: 'p1' });

    useProjectStore.getState().renameProject('Mine');
    await flushAutosave();

    const { notice, remoteConflict } = useProjectStore.getState();
    expect(remoteConflict).toBe(true);
    expect(notice?.message).toMatch(/Someone else deleted this project/);
    expect(notice?.message).toMatch(/Export as JSON/);
  });
});

describe('the token threaded between writes', () => {
  /*
   * The failure this catches is the loud one: read the token from state rather than from
   * the in-flight write and every *second* save presents a pre-write timestamp, so a
   * single user editing twice in a row gets a phantom conflict.
   */
  it('is the server timestamp the previous write returned', async () => {
    const SECOND = '2026-08-31T09:00:02.000000+00:00';
    saveMock.mockResolvedValueOnce(saved(SECOND));
    saveMock.mockResolvedValueOnce(saved('2026-08-31T09:00:03.000000+00:00'));

    useProjectStore.getState().renameProject('One');
    await flushAutosave();
    useProjectStore.getState().renameProject('Two');
    await flushAutosave();

    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(tokenOfCall(0)).toBe(FIRST);
    expect(tokenOfCall(1)).toBe(SECOND);
    expect(useProjectStore.getState().remoteConflict).toBe(false);
  });

  it('is not moved by a refused write, since that write changed nothing', async () => {
    saveMock.mockResolvedValueOnce({ kind: 'conflict', id: 'p1', savedAt: THEIRS });
    useProjectStore.getState().renameProject('Mine');
    await flushAutosave();

    // Reloading is what clears the conflict; the next write must resume from the token
    // that reload installs, never from the one the refused write reported.
    expect(tokenOfCall(0)).toBe(FIRST);
    expect(useProjectStore.getState().lastSavedAt).toBe(FIRST);
  });
});
