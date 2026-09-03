/**
 * Document mutations that can be refused.
 *
 * `shiftTask` is the interesting one: it reorders a row among its siblings and must
 * never let it escape its parent, never throw at the ends of a list, and — because the
 * array is a flat list, not a tree — carry a summary task's whole subtree with it.
 *
 * Order is asserted through `buildWbs(...).order`, the depth-first walk the renderer
 * actually draws, rather than through `project.tasks` — the array can hold a correct
 * outline in more than one arrangement, and it is the walk that the user sees.
 */

import { describe, expect, it } from 'vitest';

import { indentTask, outdentTask, shiftTask } from './project.js';
import type { Project } from './types.js';
import { buildWbs } from './wbs.js';
import { buildProject } from '../fixtures/kit.js';

/** The visible top-to-bottom order, which is what a reorder is really about. */
function order(project: Project): string[] {
  return [...buildWbs(project.tasks).order];
}

function ok(result: ReturnType<typeof shiftTask>): Project {
  if (!result.ok) throw new Error(`Expected success, got: ${result.reason}`);
  return result.value;
}

describe('shiftTask', () => {
  const flat = () =>
    buildProject({ tasks: [{ id: 'a', dur: 1 }, { id: 'b', dur: 1 }, { id: 'c', dur: 1 }] });

  it('moves a task up among its siblings', () => {
    expect(order(ok(shiftTask(flat(), 'c', -1)))).toEqual(['a', 'c', 'b']);
  });

  it('moves a task down among its siblings', () => {
    expect(order(ok(shiftTask(flat(), 'a', 1)))).toEqual(['b', 'a', 'c']);
  });

  it('is its own inverse', () => {
    const moved = ok(shiftTask(flat(), 'a', 1));
    expect(order(ok(shiftTask(moved, 'a', -1)))).toEqual(['a', 'b', 'c']);
  });

  it('refuses to move the first sibling up, with a reason', () => {
    const result = shiftTask(flat(), 'a', -1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/first/i);
  });

  it('refuses to move the last sibling down, with a reason', () => {
    const result = shiftTask(flat(), 'c', 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/last/i);
  });

  it('refuses a task that is not in the project', () => {
    const result = shiftTask(flat(), 'nope', 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('No task nope.');
  });

  // The array is flat and `buildWbs` walks it depth-first, so a subtree is contiguous:
  // moving the summary's single element has to carry its children with it.
  it('carries a summary task’s whole subtree', () => {
    const project = buildProject({
      tasks: [
        { id: 'sum', dur: 1 },
        { id: 'kid-1', dur: 1, parent: 'sum' },
        { id: 'kid-2', dur: 1, parent: 'sum' },
        { id: 'later', dur: 1 },
      ],
    });
    expect(order(ok(shiftTask(project, 'sum', 1)))).toEqual(['later', 'sum', 'kid-1', 'kid-2']);
  });

  it('carries a nested summary’s subtree when reordered inside its parent', () => {
    const project = buildProject({
      tasks: [
        { id: 'top', dur: 1 },
        { id: 'mid', dur: 1, parent: 'top' },
        { id: 'leaf', dur: 1, parent: 'mid' },
        { id: 'sibling', dur: 1, parent: 'top' },
      ],
    });
    expect(order(ok(shiftTask(project, 'mid', 1)))).toEqual(['top', 'sibling', 'mid', 'leaf']);
  });

  // Reordering is not re-parenting: a child at the end of its parent's list does not
  // fall out into the level above, it simply refuses.
  it('does not let a nested task escape its parent', () => {
    const project = buildProject({
      tasks: [
        { id: 'sum', dur: 1 },
        { id: 'kid-1', dur: 1, parent: 'sum' },
        { id: 'kid-2', dur: 1, parent: 'sum' },
        { id: 'later', dur: 1 },
      ],
    });

    expect(shiftTask(project, 'kid-1', -1).ok).toBe(false);
    expect(shiftTask(project, 'kid-2', 1).ok).toBe(false);

    const moved = ok(shiftTask(project, 'kid-2', -1));
    expect(order(moved)).toEqual(['sum', 'kid-2', 'kid-1', 'later']);
    expect(buildWbs(moved.tasks).parentOf.get('kid-2')).toBe('sum');
  });

  it('leaves the input project untouched', () => {
    const project = flat();
    const before = order(project);
    ok(shiftTask(project, 'a', 1));
    expect(order(project)).toEqual(before);
  });
});

describe('indentTask and outdentTask', () => {
  const project = () =>
    buildProject({ tasks: [{ id: 'a', dur: 1 }, { id: 'b', dur: 1 }, { id: 'c', dur: 1 }] });

  it('nests a task under its preceding sibling', () => {
    const next = ok(indentTask(project(), 'b'));
    expect(buildWbs(next.tasks).parentOf.get('b')).toBe('a');
    expect(order(next)).toEqual(['a', 'b', 'c']);
  });

  it('refuses to indent the first task, which has nothing above it', () => {
    const result = indentTask(project(), 'a');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('Nothing to indent under.');
  });

  it('promotes a child back to its grandparent’s level, just after its old parent', () => {
    const nested = ok(indentTask(project(), 'b'));
    const next = ok(outdentTask(nested, 'b'));
    expect(buildWbs(next.tasks).parentOf.get('b')).toBeNull();
    expect(order(next)).toEqual(['a', 'b', 'c']);
  });

  it('refuses to outdent a task already at the top level', () => {
    const result = outdentTask(project(), 'a');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('Already at the top level.');
  });
});
