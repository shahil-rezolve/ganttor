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
 * **Save is an upsert keyed by id.** Autosave fires on a debounce during a drag, and the
 * project may or may not exist server-side yet; making the caller track "created or not"
 * would put a race into the hot path. It writes, and tells you the id it wrote.
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

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase().auth.getUser();
  if (error) throw new Error(error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
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

/** Upsert. Returns the id actually written, which is `id` when one was supplied. */
export async function saveProjectById(
  id: string | null,
  project: Project,
  now: Date = new Date(),
): Promise<string> {
  const document: StoredDocument = {
    version: DOCUMENT_VERSION,
    savedAt: now.toISOString(),
    project,
  };

  if (isSupabaseConfigured()) {
    const ownerId = await currentUserId();
    const payload = {
      ...(id ? { id } : {}),
      owner_id: ownerId,
      name: project.name,
      document: document as unknown as Record<string, unknown>,
      document_version: DOCUMENT_VERSION,
    };
    const { data, error } = await supabase()
      .from('projects')
      .upsert(payload, { onConflict: 'id' })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    return (data as { id: string }).id;
  }

  const rowId = id ?? newId();
  const database = await localDb();
  const row: LocalRow = {
    id: rowId,
    name: project.name,
    updatedAt: document.savedAt,
    document,
  };
  await database.put(LOCAL_DOCUMENTS_STORE, row, rowId);
  return rowId;
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

export async function renameProjectById(id: string, name: string): Promise<void> {
  if (isSupabaseConfigured()) {
    const { error } = await supabase().from('projects').update({ name }).eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const database = await localDb();
  const row = (await database.get(LOCAL_DOCUMENTS_STORE, id)) as LocalRow | undefined;
  if (!row) return;
  await database.put(LOCAL_DOCUMENTS_STORE, { ...row, name }, id);
}
