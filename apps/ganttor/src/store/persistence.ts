/**
 * Persistence: the document format, and the local IndexedDB store behind it.
 *
 * The project document *is* the unit of storage — Supabase keeps one JSONB blob per row
 * and IndexedDB keeps one value per key — so two things follow either way:
 *
 * 1. **A version stamp on every saved document.** A schema change must be able to read
 *    yesterday's autosave rather than throw away the user's work, so the loader routes
 *    through `migrate()`.
 * 2. **Validation on load, not trust.** A hand-edited `.ganttor.json`, a stale autosave,
 *    or a row written by an older build can be malformed, and the failure mode has to be
 *    a clear message rather than a chart that renders half a project.
 *
 * `parseDocument` is therefore shared by both backends: rows coming out of Postgres get
 * exactly the same validation and migration as bytes coming out of IndexedDB.
 *
 * This module is the *local* half. `projectRepository.ts` chooses between it and Supabase.
 */

import { openDB, type IDBPDatabase } from 'idb';

import { DEFAULT_CALENDAR, DEFAULT_SETTINGS, type Project } from '@ganttor/gantt/core';

const DB_NAME = 'ganttor';
const STORE = 'projects';
/** Keyed by project id — the local mirror of the Supabase `projects` table. */
const DOCUMENTS_STORE = 'documents';
const DB_VERSION = 2;

/** Bumped when the persisted shape changes. `migrate()` handles older values. */
export const DOCUMENT_VERSION = 1;

export interface StoredDocument {
  version: number;
  savedAt: string;
  project: Project;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

/**
 * The shared connection.
 *
 * `upgrade` creates whatever is missing rather than branching on the old version number,
 * because a browser can arrive here from either version 1 (autosave only) or from
 * nothing at all, and "create if absent" covers both without a version ladder.
 */
export function localDb(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE);
      }
      if (!database.objectStoreNames.contains(DOCUMENTS_STORE)) {
        database.createObjectStore(DOCUMENTS_STORE);
      }
    },
  });
  return dbPromise;
}

const db = localDb;

export const LOCAL_DOCUMENTS_STORE = DOCUMENTS_STORE;

const ACTIVE_KEY = 'active';

export async function saveProject(project: Project, now: Date = new Date()): Promise<void> {
  const document: StoredDocument = {
    version: DOCUMENT_VERSION,
    savedAt: now.toISOString(),
    project,
  };
  const database = await db();
  await database.put(STORE, document, ACTIVE_KEY);
}

export async function loadProject(): Promise<{ project: Project; savedAt: string } | null> {
  const database = await db();
  const raw = (await database.get(STORE, ACTIVE_KEY)) as unknown;
  if (!raw) return null;
  const document = parseDocument(raw);
  return { project: document.project, savedAt: document.savedAt };
}

export async function clearProject(): Promise<void> {
  const database = await db();
  await database.delete(STORE, ACTIVE_KEY);
}

/** Serialised form of a `.ganttor.json` file. */
export function serializeProject(project: Project, now: Date = new Date()): string {
  const document: StoredDocument = {
    version: DOCUMENT_VERSION,
    savedAt: now.toISOString(),
    project,
  };
  return JSON.stringify(document, null, 2);
}

export function deserializeProject(text: string): Project {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  return parseDocument(raw).project;
}

/**
 * Validates and migrates a stored value.
 *
 * Deliberately strict about structure and lenient about optional fields: a missing
 * `settings` key is filled with defaults, but a missing `tasks` array is an error,
 * because guessing there would silently discard a project.
 */
export function parseDocument(raw: unknown): StoredDocument {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('That file does not contain a Ganttor project.');
  }

  const candidate = raw as Partial<StoredDocument>;
  const version = typeof candidate.version === 'number' ? candidate.version : 0;
  if (version > DOCUMENT_VERSION) {
    throw new Error(
      `That project was saved by a newer version of Ganttor (format ${version}, this build reads ${DOCUMENT_VERSION}).`,
    );
  }

  const project = candidate.project;
  if (typeof project !== 'object' || project === null) {
    throw new Error('That file does not contain a Ganttor project.');
  }
  if (!Array.isArray((project as Project).tasks)) {
    throw new Error('That project is missing its task list.');
  }

  return {
    version: DOCUMENT_VERSION,
    savedAt: typeof candidate.savedAt === 'string' ? candidate.savedAt : new Date(0).toISOString(),
    project: migrate(project as Project, version),
  };
}

/**
 * Fills in anything a older document may lack.
 *
 * Version 0 is "anything written before the format was stamped", so it gets the full
 * defaulting treatment. There is nothing to migrate between 1 and 1; the branch exists
 * so the next schema change has an obvious home.
 */
function migrate(project: Project, _fromVersion: number): Project {
  return {
    ...project,
    startDate: project.startDate ?? '1970-01-01',
    calendar: project.calendar ?? DEFAULT_CALENDAR,
    tasks: project.tasks.map((task) => ({
      ...task,
      parentId: task.parentId ?? null,
      assigneeIds: task.assigneeIds ?? [],
      percentComplete: Number.isFinite(task.percentComplete) ? task.percentComplete : 0,
      durationDays: Number.isFinite(task.durationDays) ? task.durationDays : 1,
      status: task.status ?? 'not-started',
      priority: task.priority ?? 'medium',
    })),
    dependencies: (project.dependencies ?? []).map((dep) => ({
      ...dep,
      type: dep.type ?? 'FS',
      lagDays: Number.isFinite(dep.lagDays) ? dep.lagDays : 0,
    })),
    resources: project.resources ?? [],
    baselines: project.baselines ?? [],
    activeBaselineId: project.activeBaselineId ?? null,
    settings: { ...DEFAULT_SETTINGS, ...(project.settings ?? {}) },
  };
}

/** Triggers a browser download. */
export function downloadProject(project: Project, filename?: string): void {
  const name = filename ?? `${slug(project.name)}.ganttor.json`;
  const blob = new Blob([serializeProject(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}
