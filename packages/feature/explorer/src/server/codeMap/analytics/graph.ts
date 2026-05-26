/**
 * CodeIndex → AnalyticsGraph adapter.
 *
 * Walks every IndexedFile once, materialising:
 *   - symbol nodes (one per flatSymbols entry)
 *   - **virtual file-nodes** (P0-3: one per file, qname = "__file__")
 *   - intraCall edges (in-file caller → callee)
 *   - crossCall edges (outgoingCalls / incomingCalls pairs)
 *   - import edges (file-node A → file-node B)
 *   - file-aggregate edges (file-node F ↔ every symbol in F)
 *
 * Why virtual file-nodes (P0-3):
 *   The original implementation anchored every import edge to the
 *   "first symbol of the file". That worked but produced a very
 *   skewed PageRank distribution on small projects — only the anchor
 *   symbols captured the import-flow mass, every other symbol in the
 *   same file got near-zero PR. By introducing a virtual file-node
 *   that receives the file's import flow and redistributes it to all
 *   member symbols, we get a much more useful PR distribution where
 *   "every symbol in a heavily-imported file is somewhat important"
 *   AND "the file itself is its own node" (file-level importance is
 *   queryable too). PR cross-project tests on small Cockpit jump
 *   from ~100× spread to ~1000× spread.
 *
 *   File-nodes are filtered out of all builder results (see the
 *   SYNTHETIC_QNAME pattern that catches `__file__`).
 *
 * Edge weight policy:
 *   - intraCall / crossCall: number of distinct call-site lines
 *     (`edge.lines.length`), so a function called 5× from one caller
 *     contributes 5× the probability mass during random-walk steps.
 *   - import: 1 per resolved import — imports are coarse-grained
 *     and adding multiplicity here just inflates noise.
 *   - file-aggregate: 1/N where N is the number of symbols in the
 *     file — splits the file-node's outflow equally among its symbols.
 *     Symbols flow back to the file-node with weight 1 (so file
 *     importance accumulates from its members).
 */
import type { CodeIndex } from '../projectGraph/codeIndex';
import type { AnalyticsGraph, Edge, NodeId, NodeMeta } from './types';
import { makeNodeId } from './types';

/** Synthetic qname used for virtual file-nodes. Filtered out at the
 *  projection layer (contextBuilder / relatedBuilder / impactScorer
 *  all share a SYNTHETIC_QNAME regex that matches `__file__`). */
export const FILE_NODE_QNAME = '__file__';

/** Build the file-node id for a given filePath. */
export function fileNodeId(filePath: string): NodeId {
  return makeNodeId(filePath, FILE_NODE_QNAME);
}

/** Build an AnalyticsGraph from a CodeIndex snapshot. O(N + E). */
export function buildAnalyticsGraph(
  index: CodeIndex,
  version: number,
): AnalyticsGraph {
  const nodes = new Map<NodeId, NodeMeta>();
  const out = new Map<NodeId, Edge[]>();
  const inn = new Map<NodeId, Edge[]>();

  const pushEdge = (
    map: Map<NodeId, Edge[]>,
    from: NodeId,
    edge: Edge,
  ): void => {
    let list = map.get(from);
    if (!list) {
      list = [];
      map.set(from, list);
    }
    list.push(edge);
  };

  // 1. Collect all symbol nodes + virtual file-nodes.
  for (const [filePath, file] of index.files) {
    for (const sym of file.flatSymbols) {
      const id = makeNodeId(filePath, sym.qualifiedName);
      if (!nodes.has(id)) {
        nodes.set(id, {
          filePath,
          qualifiedName: sym.qualifiedName,
          name: sym.name,
          kind: sym.kind,
          startLine: sym.startLine,
          endLine: sym.endLine,
        });
      }
    }
    // Virtual file-node, even for empty files (still useful for
    // import flow). `kind` is a marker "file" — never appears in
    // actual flatSymbols so it can't collide.
    const fId = fileNodeId(filePath);
    if (!nodes.has(fId)) {
      nodes.set(fId, {
        filePath,
        qualifiedName: FILE_NODE_QNAME,
        name: basename(filePath),
        // We deliberately use 'unknown' kind — SymbolKind doesn't have
        // 'file' and we don't want to expand the union for an internal
        // virtual node.
        kind: 'unknown' as NodeMeta['kind'],
        startLine: 0,
        endLine: 0,
      });
    }
  }

  // 2. Intra-file call edges.
  for (const [filePath, file] of index.files) {
    for (const call of file.intraCalls) {
      const from = makeNodeId(filePath, call.from);
      const to = makeNodeId(filePath, call.to);
      if (!nodes.has(from) || !nodes.has(to)) continue;
      const weight = Math.max(1, call.lines.length);
      pushEdge(out, from, { target: to, edgeType: 'intraCall', weight });
      pushEdge(inn, to, { target: from, edgeType: 'intraCall', weight });
    }
  }

  // 3. Cross-file call edges (use outgoingCalls — incomingCalls is its mirror).
  for (const [filePath, file] of index.files) {
    for (const call of file.outgoingCalls) {
      const from = makeNodeId(filePath, call.from);
      const to = makeNodeId(call.to.filePath, call.to.qualifiedName);
      if (!nodes.has(from) || !nodes.has(to)) continue;
      const weight = Math.max(1, call.lines.length);
      pushEdge(out, from, { target: to, edgeType: 'crossCall', weight });
      pushEdge(inn, to, { target: from, edgeType: 'crossCall', weight });
    }
  }

  // 4. Import edges: file-node A → file-node B.
  for (const [filePath, file] of index.files) {
    const fromFNode = fileNodeId(filePath);
    for (const importedFile of file.importedFiles) {
      const toFNode = fileNodeId(importedFile);
      if (!nodes.has(toFNode)) continue;
      pushEdge(out, fromFNode, {
        target: toFNode,
        edgeType: 'import',
        weight: 1,
      });
      pushEdge(inn, toFNode, {
        target: fromFNode,
        edgeType: 'import',
        weight: 1,
      });
    }
  }

  // 5. File-aggregate edges: every symbol ↔ its file-node.
  //    Symbol → file-node:   weight 1 (each member adds to file importance)
  //    File-node → symbol:   weight 1/N (file outflow splits equally)
  for (const [filePath, file] of index.files) {
    const fNode = fileNodeId(filePath);
    const symbols = file.flatSymbols;
    if (symbols.length === 0) continue;
    const outflowWeight = 1 / symbols.length;
    for (const sym of symbols) {
      const symId = makeNodeId(filePath, sym.qualifiedName);
      if (!nodes.has(symId)) continue;
      pushEdge(out, symId, {
        target: fNode,
        edgeType: 'import', // reuse type tag (no need for a new one)
        weight: 1,
      });
      pushEdge(inn, fNode, {
        target: symId,
        edgeType: 'import',
        weight: 1,
      });
      pushEdge(out, fNode, {
        target: symId,
        edgeType: 'import',
        weight: outflowWeight,
      });
      pushEdge(inn, symId, {
        target: fNode,
        edgeType: 'import',
        weight: outflowWeight,
      });
    }
  }

  return {
    cwd: index.cwd,
    version,
    nodes,
    out,
    in: inn,
  };
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/** Convenience: the anchor (first symbol) for a given file. */
export function firstSymbolOfFile(
  graph: AnalyticsGraph,
  filePath: string,
): NodeId | null {
  let earliest: { line: number; id: NodeId } | null = null;
  for (const [id, meta] of graph.nodes) {
    if (meta.filePath !== filePath) continue;
    if (meta.qualifiedName === FILE_NODE_QNAME) continue;
    if (!earliest || meta.startLine < earliest.line) {
      earliest = { line: meta.startLine, id };
    }
  }
  return earliest?.id ?? null;
}
