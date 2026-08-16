/**
 * Persistence: the IndexedDB round trip, the file format, and what happens when a
 * stored document is malformed.
 *
 * The malformed cases matter more than the happy path here. There is no server to
 * validate anything, so a hand-edited `.ganttor.json` or a stale autosave is the most
 * likely way a user meets an error — and the requirement is a clear message rather than
 * a half-rendered project.
 */

import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createDemoProject, schedule, type Project } from '@ganttor/gantt';

import {
  clearProject,
  deserializeProject,
  DOCUMENT_VERSION,
  loadProject,
  parseDocument,
  saveProject,
  serializeProject,
} from './persistence.js';

describe('IndexedDB autosave', () => {
  beforeEach(async () => {
    await clearProject();
  });

  it('returns nothing before anything has been saved', async () => {
    expect(await loadProject()).toBeNull();
  });

  it('round-trips a project unchanged', async () => {
    const project = createDemoProject();
    await saveProject(project);

    const loaded = await loadProject();
    expect(loaded).not.toBeNull();
    expect(loaded!.project.tasks).toHaveLength(project.tasks.length);
    expect(loaded!.project.dependencies).toHaveLength(project.dependencies.length);
    // The reloaded project must schedule to exactly the same dates.
    expect(schedule(loaded!.project).projectFinish).toBe(schedule(project).projectFinish);
  });

  it('overwrites the previous autosave rather than accumulating', async () => {
    await saveProject(createDemoProject());
    const renamed = { ...createDemoProject(), name: 'Second pass' };
    await saveProject(renamed);
    expect((await loadProject())!.project.name).toBe('Second pass');
  });

  it('preserves a baseline across a reload, including its frozen bars', async () => {
    const project = createDemoProject();
    const scheduled = schedule(project);
    const withBaseline: Project = {
      ...project,
      baselines: [
        {
          id: 'b1',
          name: 'Original',
          savedAt: '2026-03-02T09:00:00.000Z',
          bars: Object.fromEntries(
            [...scheduled.tasks.values()].map((task) => [
              task.id,
              {
                start: task.start,
                end: task.end,
                durationDays: task.durationDays,
                percentComplete: task.percentComplete,
              },
            ]),
          ),
        },
      ],
      activeBaselineId: 'b1',
    };

    await saveProject(withBaseline);
    const loaded = (await loadProject())!.project;
    expect(loaded.activeBaselineId).toBe('b1');
    expect(Object.keys(loaded.baselines[0]!.bars)).toHaveLength(project.tasks.length);
  });
});

describe('the .ganttor.json file format', () => {
  it('round-trips through text', () => {
    const project = createDemoProject();
    const restored = deserializeProject(serializeProject(project));
    expect(restored.tasks).toHaveLength(project.tasks.length);
    expect(schedule(restored).projectFinish).toBe(schedule(project).projectFinish);
  });

  it('stamps the format version so a future build knows what it is reading', () => {
    const parsed = JSON.parse(serializeProject(createDemoProject())) as { version: number };
    expect(parsed.version).toBe(DOCUMENT_VERSION);
  });

  it('refuses a document written by a newer build instead of mangling it', () => {
    const future = JSON.stringify({
      version: DOCUMENT_VERSION + 1,
      savedAt: '2030-01-01T00:00:00.000Z',
      project: createDemoProject(),
    });
    expect(() => deserializeProject(future)).toThrow(/newer version/i);
  });

  it('gives a plain message for input that is not JSON', () => {
    expect(() => deserializeProject('not json at all {{{')).toThrow(/not valid JSON/i);
  });

  it('gives a plain message for JSON that is not a Ganttor project', () => {
    expect(() => deserializeProject('{"hello":"world"}')).toThrow(/does not contain/i);
    expect(() => deserializeProject('null')).toThrow(/does not contain/i);
  });

  it('refuses a project with no task list rather than opening an empty chart', () => {
    const headless = JSON.stringify({ version: 1, savedAt: '', project: { id: 'x', name: 'x' } });
    expect(() => deserializeProject(headless)).toThrow(/missing its task list/i);
  });
});

describe('migrating an older document', () => {
  it('fills in fields an unversioned document predates', () => {
    // A version-0 document: written before the format was stamped, so it lacks
    // settings, resources, baselines, and per-field defaults.
    const ancient = {
      project: {
        id: 'old',
        name: 'Old project',
        startDate: '2026-03-02',
        tasks: [{ id: 't1', name: 'Task', durationDays: 3 }],
        dependencies: [{ id: 'd1', predecessorId: 't1', successorId: 't1' }],
      },
    };

    const document = parseDocument(ancient);
    const project = document.project;

    expect(document.version).toBe(DOCUMENT_VERSION);
    expect(project.calendar).toBeDefined();
    expect(project.settings.colorBy).toBe('status');
    expect(project.resources).toEqual([]);
    expect(project.baselines).toEqual([]);
    expect(project.activeBaselineId).toBeNull();

    const task = project.tasks[0]!;
    expect(task.parentId).toBeNull();
    expect(task.assigneeIds).toEqual([]);
    expect(task.percentComplete).toBe(0);
    expect(task.status).toBe('not-started');
    expect(task.priority).toBe('medium');

    // A dependency with no type defaults to finish-to-start with no lag.
    expect(project.dependencies[0]!.type).toBe('FS');
    expect(project.dependencies[0]!.lagDays).toBe(0);

    // And the result is schedulable, which is the only test that really matters.
    expect(() => schedule(project)).not.toThrow();
  });

  it('repairs a non-numeric duration rather than producing NaN dates', () => {
    const broken = {
      version: 1,
      project: {
        id: 'x',
        name: 'x',
        startDate: '2026-03-02',
        tasks: [{ id: 't1', name: 'Task', durationDays: 'three' }],
        dependencies: [],
      },
    };
    const project = parseDocument(broken).project;
    expect(project.tasks[0]!.durationDays).toBe(1);
    expect(Number.isFinite(schedule(project).projectFinish)).toBe(true);
  });
});
