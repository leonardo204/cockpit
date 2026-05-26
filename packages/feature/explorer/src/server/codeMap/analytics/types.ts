/**
 * Analytics types — the graph abstraction layer + signal shapes.
 *
 * The codeMap CodeIndex is rich but oriented around "chip view"
 * rendering (cross-file edges, intra-file pins, ext/method pin
 * fallbacks). For ranking algorithms we want a flatter, edge-typed
 * adjacency representation that's cheap to iterate billions of times
 * during power-iteration / random-walk loops. That's `AnalyticsGraph`.
 *
 * Node id format: `${filePath}::${qualifiedName}`. Stable string keys
 * are nicer for sparse maps + JSON debug dumps than numeric ids; the
 * extra memory cost is negligible at 10K-node scale.
 */
import type { SymbolKind } from '../types';

export type NodeId = string; // `${filePath}::${qualifiedName}`

export interface NodeMeta {
  filePath: string;
  qualifiedName: string;
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  /** Identifier tokens used for TF-IDF. Computed lazily on first
   *  TfidfIndex build, then cached on the meta to avoid re-tokenising
   *  on graph rebuild. */
  tokens?: string[];
}

export type EdgeType = 'intraCall' | 'crossCall' | 'import';

export interface Edge {
  target: NodeId;
  edgeType: EdgeType;
  /** Call-site count (for calls) or 1 (for imports). Used as power
   *  weight in PageRank / PPR transitions so heavily-called edges
   *  carry more probability mass. */
  weight: number;
}

export interface AnalyticsGraph {
  cwd: string;
  /** Monotonic version tag — bumped when the underlying CodeIndex is
   *  rebuilt or refreshed. Caches use this to detect staleness without
   *  a deep compare. */
  version: number;
  nodes: Map<NodeId, NodeMeta>;
  /** Out-adjacency (this node calls / imports → targets). */
  out: Map<NodeId, Edge[]>;
  /** In-adjacency (callers / importers → this node). */
  in: Map<NodeId, Edge[]>;
}

// ============================================================================
// Helpers
// ============================================================================

export function makeNodeId(filePath: string, qualifiedName: string): NodeId {
  return `${filePath}::${qualifiedName}`;
}

export function parseNodeId(
  id: NodeId,
): { filePath: string; qualifiedName: string } | null {
  const idx = id.indexOf('::');
  if (idx < 0) return null;
  return {
    filePath: id.slice(0, idx),
    qualifiedName: id.slice(idx + 2),
  };
}
