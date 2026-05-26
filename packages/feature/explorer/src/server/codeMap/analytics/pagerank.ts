/**
 * PageRank + Personalized PageRank.
 *
 * Standard power-iteration on `AnalyticsGraph.in` (incoming edges). Edge
 * weights are normalised by the source node's total out-weight so the
 * transition matrix is row-stochastic. Dangling nodes (no outgoing
 * edges) redistribute their mass uniformly across all nodes — standard
 * sink-leak fix.
 *
 * Both functions share the same iteration kernel; `personalizedPageRank`
 * differs only in the reset (teleport) vector — uniform vs concentrated
 * on the seeds. Sharing the kernel avoids drift between the two
 * implementations.
 */
import type { AnalyticsGraph, NodeId } from './types';

export interface PageRankOptions {
  damping?: number; // default 0.85
  maxIter?: number; // default 50
  tol?: number; // default 1e-6 (L1 delta)
}

export interface PPROptions extends PageRankOptions {
  /** Cap the returned ranking to topK by score (descending). 0 = all. */
  topK?: number;
}

interface OutSumCache {
  /** node → sum of out-edge weights (cached for the lifetime of one call). */
  outSum: Map<NodeId, number>;
  /** dangling-node set (zero out-weight). */
  dangling: NodeId[];
}

function buildOutSumCache(graph: AnalyticsGraph): OutSumCache {
  const outSum = new Map<NodeId, number>();
  const dangling: NodeId[] = [];
  for (const id of graph.nodes.keys()) {
    const edges = graph.out.get(id);
    if (!edges || edges.length === 0) {
      outSum.set(id, 0);
      dangling.push(id);
      continue;
    }
    let s = 0;
    for (const e of edges) s += e.weight;
    outSum.set(id, s);
  }
  return { outSum, dangling };
}

/** Core iteration. `resetVec` is the teleport distribution (must sum to 1). */
function iterate(
  graph: AnalyticsGraph,
  resetVec: Map<NodeId, number>,
  damping: number,
  maxIter: number,
  tol: number,
  cache: OutSumCache,
): Map<NodeId, number> {
  const n = graph.nodes.size;
  if (n === 0) return new Map();

  // Initial distribution = reset (gives PPR the right starting bias;
  // standard PR doesn't care because uniform either way).
  let rank = new Map<NodeId, number>();
  for (const id of graph.nodes.keys()) {
    rank.set(id, resetVec.get(id) ?? 0);
  }

  for (let iter = 0; iter < maxIter; iter++) {
    const next = new Map<NodeId, number>();
    // teleport contribution
    for (const id of graph.nodes.keys()) {
      next.set(id, (1 - damping) * (resetVec.get(id) ?? 0));
    }

    // dangling mass redistributed via teleport (sink leak fix)
    let danglingMass = 0;
    for (const d of cache.dangling) danglingMass += rank.get(d) ?? 0;
    if (danglingMass > 0) {
      const distributed = damping * danglingMass;
      for (const [id, w] of resetVec) {
        next.set(id, (next.get(id) ?? 0) + distributed * w);
      }
    }

    // edge contributions: for each node, push rank/outSum * weight to neighbors
    for (const [id, edges] of graph.out) {
      const s = cache.outSum.get(id) ?? 0;
      if (s === 0) continue;
      const share = (damping * (rank.get(id) ?? 0)) / s;
      if (share === 0) continue;
      for (const e of edges) {
        next.set(e.target, (next.get(e.target) ?? 0) + share * e.weight);
      }
    }

    // L1 delta for convergence check
    let delta = 0;
    for (const id of graph.nodes.keys()) {
      delta += Math.abs((next.get(id) ?? 0) - (rank.get(id) ?? 0));
    }
    rank = next;
    if (delta < tol) break;
  }

  return rank;
}

function normaliseResetVec(
  graph: AnalyticsGraph,
  seeds?: ReadonlyMap<NodeId, number>,
): Map<NodeId, number> {
  const out = new Map<NodeId, number>();
  if (!seeds || seeds.size === 0) {
    // Uniform teleport.
    const w = 1 / Math.max(1, graph.nodes.size);
    for (const id of graph.nodes.keys()) out.set(id, w);
    return out;
  }
  // Filter seeds to nodes we actually know; renormalise.
  let sum = 0;
  for (const [id, w] of seeds) {
    if (graph.nodes.has(id) && w > 0) {
      out.set(id, w);
      sum += w;
    }
  }
  if (sum === 0) {
    // Fallback to uniform (caller passed seeds that all missed).
    const w = 1 / Math.max(1, graph.nodes.size);
    for (const id of graph.nodes.keys()) out.set(id, w);
    return out;
  }
  for (const [id, w] of out) out.set(id, w / sum);
  return out;
}

/** Standard PageRank. Returns score for every node, summing to ~1. */
export function pagerank(
  graph: AnalyticsGraph,
  opts: PageRankOptions = {},
): Map<NodeId, number> {
  const damping = opts.damping ?? 0.85;
  const maxIter = opts.maxIter ?? 50;
  const tol = opts.tol ?? 1e-6;
  const cache = buildOutSumCache(graph);
  return iterate(graph, normaliseResetVec(graph), damping, maxIter, tol, cache);
}

export interface PPRResult {
  node: NodeId;
  score: number;
}

/** Personalized PageRank biased toward `seeds`.
 *  Seeds can be a Map (id → weight) or a plain array (equal weight). */
export function personalizedPageRank(
  graph: AnalyticsGraph,
  seeds: ReadonlyArray<NodeId> | ReadonlyMap<NodeId, number>,
  opts: PPROptions = {},
): PPRResult[] {
  const damping = opts.damping ?? 0.85;
  const maxIter = opts.maxIter ?? 30;
  const tol = opts.tol ?? 1e-6;
  const topK = opts.topK ?? 0;

  const seedMap: Map<NodeId, number> =
    Array.isArray(seeds)
      ? new Map(seeds.map((id) => [id, 1]))
      : new Map(seeds as Iterable<[NodeId, number]>);

  const resetVec = normaliseResetVec(graph, seedMap);
  const cache = buildOutSumCache(graph);
  const ranks = iterate(graph, resetVec, damping, maxIter, tol, cache);

  // Exclude seeds from the result (caller already knows them).
  const seedSet = new Set(seedMap.keys());
  const results: PPRResult[] = [];
  for (const [node, score] of ranks) {
    if (seedSet.has(node)) continue;
    if (score <= 0) continue;
    results.push({ node, score });
  }
  results.sort((a, b) => b.score - a.score);
  return topK > 0 ? results.slice(0, topK) : results;
}
