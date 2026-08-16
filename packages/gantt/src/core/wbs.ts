/**
 * Work-breakdown structure: the parent/child tree behind the task grid.
 *
 * A task with children is a *summary* task. Summary bars are rollups — their dates
 * are the span of their children and cannot be set directly — which is why the
 * scheduler treats them as a separate kind rather than as tasks that happen to
 * have children.
 *
 * Imported data lies. A `parentId` may point at a task that does not exist, or two
 * tasks may claim each other as parent. Both are repaired here by detaching the
 * offending task to the top level and recording it, so the rest of the engine can
 * assume a well-formed tree.
 */

import type { Task } from './types.js';

export interface Wbs {
  /** Child ids in display order, keyed by parent id. Only summary tasks appear. */
  childrenOf: ReadonlyMap<string, string[]>;
  roots: string[];
  depthOf: ReadonlyMap<string, number>;
  /** Depth-first display order: a parent immediately followed by its subtree. */
  order: string[];
  /** Effective parent after repair, which may differ from `task.parentId`. */
  parentOf: ReadonlyMap<string, string | null>;
  /** Tasks re-parented to the top level because their `parentId` was unusable. */
  detachedIds: ReadonlySet<string>;
  isSummary(id: string): boolean;
  /** Leaf tasks in the subtree rooted at `id`. `[id]` when `id` is itself a leaf. */
  leafDescendants(id: string): string[];
}

export function buildWbs(tasks: readonly Task[]): Wbs {
  const byId = new Map<string, Task>();
  for (const task of tasks) byId.set(task.id, task);

  const detachedIds = new Set<string>();
  const parentOf = new Map<string, string | null>();

  for (const task of tasks) {
    const declared = task.parentId;
    if (declared === null || declared === undefined) {
      parentOf.set(task.id, null);
      continue;
    }
    if (!byId.has(declared) || declared === task.id) {
      parentOf.set(task.id, null);
      detachedIds.add(task.id);
      continue;
    }
    parentOf.set(task.id, declared);
  }

  // Break parent chains that loop. Walking up from every task is O(n·depth), which
  // is nothing at Gantt scale and far simpler than a union-find.
  for (const task of tasks) {
    const seen = new Set<string>([task.id]);
    let cursor = parentOf.get(task.id) ?? null;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        parentOf.set(cursor, null);
        detachedIds.add(cursor);
        break;
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }

  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const task of tasks) {
    const parent = parentOf.get(task.id) ?? null;
    if (parent === null) {
      roots.push(task.id);
      continue;
    }
    let siblings = childrenOf.get(parent);
    if (!siblings) childrenOf.set(parent, (siblings = []));
    siblings.push(task.id);
  }

  const depthOf = new Map<string, number>();
  const order: string[] = [];
  const stack = [...roots].reverse().map((id) => ({ id, depth: 0 }));
  while (stack.length > 0) {
    const { id, depth } = stack.pop()!;
    order.push(id);
    depthOf.set(id, depth);
    const children = childrenOf.get(id);
    if (children) {
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ id: children[i]!, depth: depth + 1 });
      }
    }
  }

  const isSummary = (id: string): boolean => (childrenOf.get(id)?.length ?? 0) > 0;

  const leafCache = new Map<string, string[]>();
  const leafDescendants = (id: string): string[] => {
    const cached = leafCache.get(id);
    if (cached) return cached;
    const leaves: string[] = [];
    const walk = [id];
    while (walk.length > 0) {
      const current = walk.pop()!;
      const children = childrenOf.get(current);
      if (!children || children.length === 0) {
        leaves.push(current);
        continue;
      }
      for (let i = children.length - 1; i >= 0; i--) walk.push(children[i]!);
    }
    leafCache.set(id, leaves);
    return leaves;
  };

  return {
    childrenOf,
    roots,
    depthOf,
    order,
    parentOf,
    detachedIds,
    isSummary,
    leafDescendants,
  };
}
