/**
 * Directed-graph primitives for the scheduler.
 *
 * The scheduler needs three things from the graph: a topological order to walk, the
 * identity of the edges that make a topological order impossible, and the actual
 * cycle path so an error message can say `BRAIN-4 → BRAIN-9 → BRAIN-12 → BRAIN-4`
 * instead of "circular dependency detected".
 *
 * A single depth-first search produces all three. Edges that point at a node still
 * on the DFS stack are back edges; removing exactly those leaves a DAG, and the
 * reverse finishing order of that DAG is a valid topological order.
 */

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
}

export interface GraphAnalysis {
  /** Topological order of the graph with back edges removed. */
  order: string[];
  /** Edges whose removal makes the graph acyclic. */
  backEdgeIds: Set<string>;
  /** One path per back edge, first node repeated last: `[a, b, c, a]`. */
  cycles: string[][];
}

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

/**
 * Depth-first analysis. Iterative rather than recursive so that a pathological
 * dependency chain cannot blow the JS stack.
 *
 * Which edges are classified as back edges depends on visit order, which is
 * `nodeIds` order followed by edge order — deterministic for a given project.
 */
export function analyzeGraph(nodeIds: readonly string[], edges: readonly GraphEdge[]): GraphAnalysis {
  const adjacency = new Map<string, GraphEdge[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const edge of edges) {
    const out = adjacency.get(edge.from);
    // Edges referencing unknown nodes are not this module's problem to report.
    if (out && adjacency.has(edge.to)) out.push(edge);
  }

  const color = new Map<string, number>();
  for (const id of nodeIds) color.set(id, WHITE);

  const backEdgeIds = new Set<string>();
  const cycles: string[][] = [];
  const finished: string[] = [];
  const stackIndexOf = new Map<string, number>();

  for (const root of nodeIds) {
    if (color.get(root) !== WHITE) continue;

    const stack: { node: string; next: number }[] = [{ node: root, next: 0 }];
    color.set(root, GRAY);
    stackIndexOf.set(root, 0);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const out = adjacency.get(frame.node)!;

      if (frame.next < out.length) {
        const edge = out[frame.next++]!;
        const target = color.get(edge.to);

        if (target === GRAY) {
          backEdgeIds.add(edge.id);
          const from = stackIndexOf.get(edge.to)!;
          cycles.push([...stack.slice(from).map((f) => f.node), edge.to]);
        } else if (target === WHITE) {
          color.set(edge.to, GRAY);
          stackIndexOf.set(edge.to, stack.length);
          stack.push({ node: edge.to, next: 0 });
        }
        // BLACK targets are forward or cross edges; both are acyclic.
        continue;
      }

      color.set(frame.node, BLACK);
      stackIndexOf.delete(frame.node);
      finished.push(frame.node);
      stack.pop();
    }
  }

  return { order: finished.reverse(), backEdgeIds, cycles };
}

/** Shortest path from `from` to `to` following edge direction, or `null`. */
export function findPath(
  edges: readonly GraphEdge[],
  from: string,
  to: string,
): string[] | null {
  if (from === to) return [from];

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    let out = adjacency.get(edge.from);
    if (!out) adjacency.set(edge.from, (out = []));
    out.push(edge.to);
  }

  const previous = new Map<string, string>();
  const queue = [from];
  const seen = new Set([from]);

  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const next of adjacency.get(node) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, node);
      if (next === to) {
        const path = [to];
        for (let step = to; previous.has(step); ) {
          step = previous.get(step)!;
          path.unshift(step);
        }
        return path;
      }
      queue.push(next);
    }
  }

  return null;
}
