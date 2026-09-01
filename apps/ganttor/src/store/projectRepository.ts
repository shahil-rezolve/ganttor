/**
 * Where projects live.
 *
 * One API, two backends. Supabase is the real one; IndexedDB is what runs when no
 * credentials are configured — a fresh clone, and the test suite. Choosing at call time
 * rather than at import means a `.env.local` added later takes effect on reload without
 * touching any calling code.
 *
 * Both backends return documents through `parseDocument`, so a row from Postgres gets the
 * same validation and version migration as a value from IndexedDB. A backend that skipped
 * it would be the one place a malformed project could reach the scheduler.
 *
 * **Save is an insert or a guarded update, never an upsert.** The workspace is shared, so
 * a whole-document write has to prove it is not clobbering a teammate: the caller passes
 * the `updated_at` it last saw and the update matches on it, which PostgREST cannot
 * express against the `DO UPDATE` arm of an upsert. Splitting the two is safe because the
 * store already tracks created-vs-not through its open-document ref — the very race the
 * old upsert comment worried about. `saveProjectById` reports which of the three things
 * happened rather than throwing, because a conflict is not an error.
 */

import { type Project } from '@ganttor/gantt/core';

import { isSupabaseConfigured, supabase } from '../lib/supabase.js';
import {
  DOCUMENT_VERSION,
  LOCAL_DOCUMENTS_STORE,
  localDb,
  parseDocument,
  type StoredDocument,
} from './persistence.js';

/** Enough to render the project picker without loading every document. */
export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export interface LoadedProject {
  project: Project;
  savedAt: string;
}

/** Which backend is actually in use, for the UI to report honestly. */
export function backendName(): 'supabase' | 'local' {
  return isSupabaseConfigured() ? 'supabase' : 'local';
}

// ── Supabase ───────────────────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  document: unknown;
  updated_at: string;
}

// ── Local (IndexedDB) ──────────────────────────────────────────────────────────────────

interface LocalRow {
  id: string;
  name: string;
  updatedAt: string;
  document: StoredDocument;
}

function newId(): string {
  // `randomUUID` needs a secure context; a plain-HTTP LAN preview is not one.
  return globalThis.crypto?.randomUUID?.() ?? `p-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── The API ────────────────────────────────────────────────────────────────────────────

export async function listProjects(): Promise<ProjectSummary[]> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase()
      .from('projects')
      .select('id, name, updated_at')
      .order('updated_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => ({
      id: row.id as string,
      name: (row.name as string) || 'Untitled project',
      updatedAt: row.updated_at as string,
    }));
  }

  const database = await localDb();
  const rows = ((await database.getAll(LOCAL_DOCUMENTS_STORE)) ?? []) as LocalRow[];
  return rows
    .map((row) => ({ id: row.id, name: row.name || 'Untitled project', updatedAt: row.updatedAt }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadProjectById(id: string): Promise<LoadedProject | null> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase()
      .from('projects')
      .select('id, name, document, updated_at')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;

    const row = data as unknown as ProjectRow;
    const document = parseDocument(row.document);
    // The row's `name` column is what the picker sorts and displays, so it wins over a
    // stale name inside the blob if the two ever disagree.
    return {
      project: { ...document.project, name: row.name || document.project.name },
      savedAt: row.updated_at,
    };
  }

  const database = await localDb();
  const row = (await database.get(LOCAL_DOCUMENTS_STORE, id)) as LocalRow | undefined;
  if (!row) return null;
  const document = parseDocument(row.document);
  return { project: document.project, savedAt: row.updatedAt };
}

/**
 * What a save did. `savedAt` is always the row's *current* server `updated_at`, so the
 * caller can carry it forward as the token for its next write — including after a
 * conflict, where it is the value that beat us.
 */
export type SaveOutcome =
  | { kind: 'saved'; id: string; savedAt: string }
  /** Someone else wrote the row since `expectedSavedAt`. Nothing was written. */
  | { kind: 'conflict'; id: string; savedAt: string }
  /** The row is gone. Nothing was written. */
  | { kind: 'gone'; id: string };

/**
 * Write the document.
 *
 * `id === null` inserts and mints a row id; otherwise it updates, refusing the write if
 * the row has moved since `expectedSavedAt`. A **null** `expectedSavedAt` deliberately
 * degrades to an unconditional update: a guard that fails open on save beats one that
 * locks someone out of their own document.
 */
export async function saveProjectById(
  id: string | null,
  project: Project,
  expectedSavedAt: string | null,
  now: Date = new Date(),
): Promise<SaveOutcome> {
  const document: StoredDocument = {
    version: DOCUMENT_VERSION,
    savedAt: now.toISOString(),
    project,
  };

  if (isSupabaseConfigured()) {
    const payload = {
      name: project.name,
      document: document as unknown as Record<string, unknown>,
      document_version: DOCUMENT_VERSION,
    };

    if (id === null) {
      // `owner_id` is left to the column default (`auth.uid()`), so provenance comes from
      // the JWT rather than from a round trip the autosave path would pay on every save.
      const { data, error } = await supabase()
        .from('projects')
        .insert(payload)
        .select('id, updated_at')
        .single();
      if (error) throw new Error(error.message);
      const row = data as unknown as { id: string; updated_at: string };
      return { kind: 'saved', id: row.id, savedAt: row.updated_at };
    }

    let update = supabase().from('projects').update(payload).eq('id', id);
    if (expectedSavedAt) update = update.eq('updated_at', expectedSavedAt);
    // `maybeSingle`, not `single`: zero rows is the *expected* outcome of a refused
    // precondition, and `single()` would raise PGRST116 and surface it as a generic
    // autosave failure rather than a conflict.
    const { data, error } = await update.select('id, updated_at').maybeSingle();
    if (error) throw new Error(error.message);
    if (data) {
      const row = data as unknown as { id: string; updated_at: string };
      return { kind: 'saved', id: row.id, savedAt: row.updated_at };
    }

    // Nothing matched. One probe tells the two unhappy cases apart — only ever on this
    // path, so the extra round trip stays out of the hot path.
    const probe = await supabase()
      .from('projects')
      .select('updated_at')
      .eq('id', id)
      .maybeSingle();
    if (probe.error) throw new Error(probe.error.message);
    if (!probe.data) return { kind: 'gone', id };
    return {
      kind: 'conflict',
      id,
      savedAt: (probe.data as unknown as { updated_at: string }).updated_at,
    };
  }

  // One browser, one writer: `expectedSavedAt` has nothing to guard against here, and a
  // precondition would be ceremony. The `savedAt` returned is the same value
  // `loadProjectById` reports for this row, so the caller's token stays coherent across
  // both backends.
  const rowId = id ?? newId();
  const database = await localDb();
  const row: LocalRow = {
    id: rowId,
    name: project.name,
    updatedAt: document.savedAt,
    document,
  };
  await database.put(LOCAL_DOCUMENTS_STORE, row, rowId);
  return { kind: 'saved', id: rowId, savedAt: document.savedAt };
}

export async function deleteProjectById(id: string): Promise<void> {
  if (isSupabaseConfigured()) {
    const { error } = await supabase().from('projects').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const database = await localDb();
  await database.delete(LOCAL_DOCUMENTS_STORE, id);
}
