/**
 * blockDiffProjection — pure helpers for turning a (oldContent,
 * newContent, filePath) triple into the data the chip-view diff
 * (`BlockDiffViewer`) needs.
 *
 * Lives in its own module so the viewer file stays UI-only:
 *   - The viewer just calls `buildImpactProjection` and feeds the
 *     result into `BlockViewer` via three optional props
 *     (qnameFilter / accentQnames / addedLines).
 *   - This module owns the parser / line-diff / qname-classification
 *     plumbing.
 *
 * Block-pairing strategy: we parse both sides with tree-sitter, classify
 * each top-level symbol as added / deleted / modified by `qualifiedName +
 * contentHash`, and skip "fillers" (`__code_<lo>_<hi>__`) and the
 * empty-file fallback `__file__` because their qnames aren't stable
 * across snapshots. Deleted blocks are tracked but excluded from the
 * impact projection — chip view only renders after-state, so a deleted
 * block has no row to anchor pins/code to.
 */

import { computeLineDiff } from '@/components/project/diffAlgorithm';
import { extractSymbolsFromTree } from '@/lib/codeMap/extractSymbols';
import { grammarForPath } from '@/lib/codeMap/languageMap';
import { getParserFor } from '@/lib/codeMap/treeSitter';
import type { ExtractedSymbol } from '@/lib/codeMap/types';

// ============================================================================
// Block extraction + classification
// ============================================================================

type ChangeKind = 'added' | 'deleted' | 'modified';

interface BlockDiffRow {
  /** Stable id derived from the block's qualifiedName + change kind. */
  id: string;
  changeKind: ChangeKind;
  qname: string;
}

/**
 * Drop blocks whose `qualifiedName` is unstable across snapshots (file
 * fillers and the empty-file fallback) — we can't reliably pair them
 * between before / after, so they'd show as a noisy stream of "deleted
 * + added" pairs.
 */
function isDiffable(s: ExtractedSymbol): boolean {
  return !s.qualifiedName.startsWith('__code_') && s.qualifiedName !== '__file__';
}

async function extractBlocks(
  source: string,
  filePath: string,
): Promise<ExtractedSymbol[] | null> {
  if (!source) return [];
  const grammar = grammarForPath(filePath);
  if (!grammar) return null; // unsupported language → caller falls back
  const parser = await getParserFor(grammar);
  const tree = parser.parse(source);
  if (!tree) return null;
  try {
    return extractSymbolsFromTree(tree.rootNode).filter(isDiffable);
  } finally {
    tree.delete();
  }
}

/** Pair before / after blocks by qualifiedName and classify each pair. */
function diffBlocks(
  oldBlocks: readonly ExtractedSymbol[],
  newBlocks: readonly ExtractedSymbol[],
): BlockDiffRow[] {
  const oldByQname = new Map<string, ExtractedSymbol>();
  for (const s of oldBlocks) oldByQname.set(s.qualifiedName, s);
  const newByQname = new Map<string, ExtractedSymbol>();
  for (const s of newBlocks) newByQname.set(s.qualifiedName, s);

  const rows: BlockDiffRow[] = [];
  for (const after of newBlocks) {
    const before = oldByQname.get(after.qualifiedName);
    if (!before) {
      rows.push({
        id: `add:${after.qualifiedName}`,
        changeKind: 'added',
        qname: after.qualifiedName,
      });
    } else if (before.contentHash !== after.contentHash) {
      rows.push({
        id: `mod:${after.qualifiedName}`,
        changeKind: 'modified',
        qname: after.qualifiedName,
      });
    }
    // unchanged → skip
  }
  for (const before of oldBlocks) {
    if (newByQname.has(before.qualifiedName)) continue;
    rows.push({
      id: `del:${before.qualifiedName}`,
      changeKind: 'deleted',
      qname: before.qualifiedName,
    });
  }
  return rows;
}

// ============================================================================
// Public projection — what `BlockDiffViewer` (the chip-view wrapper)
// feeds into `BlockViewer` to filter rows + tint changed lines + accent
// changed-neighbour pins.
// ============================================================================

export interface ImpactProjection {
  /** qnames of every block that changed (added OR modified). Deleted
   *  blocks are intentionally omitted — they no longer exist in the
   *  after content, so they have no row to render in chip view.
   *
   *  `undefined` when the file's language has no tree-sitter grammar
   *  (CSS / SCSS / HTML / JSON / YAML / Go / Java / C++ / etc — i.e.
   *  anything outside our currently-bundled TS/TSX/JS/Python). In that
   *  case the chip view falls back to a single synthetic `__file__`
   *  block, and the caller must NOT pass `qnameFilter` (would filter
   *  the only block out and render an empty panel). `addedLines`
   *  still works because line-level diff is language-agnostic, so the
   *  user gets the green "this line changed" overlay regardless. */
  changedQnames?: Set<string>;
  /** After-file line numbers (1-based, absolute) that should render
   *  with the added/changed background tint in the chip body. Modified
   *  lines surface here too — line-level diff treats `modified =
   *  removed(old) + added(new)`, and we keep only the new side.
   *
   *  Always populated regardless of grammar support — `computeLineDiff`
   *  is pure text comparison, so this works for every language and
   *  every binary-ish text file we render. */
  addedLines: Set<number>;
}

/**
 * Async orchestrator: parse both sides, pair blocks by qname, derive
 * the changed-qname set, and compute file-wide added-line numbers.
 *
 * Always returns an `ImpactProjection`. When the language has no
 * tree-sitter grammar bundled, `changedQnames` is left undefined but
 * `addedLines` is still computed — that gives unsupported-language
 * files (CSS / Go / Java / etc) a degraded but useful chip-diff view:
 * the file renders as a single synthetic block with green tints on
 * the changed lines. Caller decides what to do with `changedQnames`
 * being undefined (typically: don't pass `qnameFilter`).
 */
export async function buildImpactProjection(
  oldContent: string,
  newContent: string,
  filePath: string,
  isNew: boolean,
  isDeleted: boolean,
): Promise<ImpactProjection> {
  // Line-level diff first — it's language-agnostic so we always get it,
  // even when the grammar lookup below comes up empty.
  const addedLines = new Set<number>();
  if (oldContent !== newContent) {
    const diffLines = computeLineDiff(
      isNew ? '' : oldContent,
      isDeleted ? '' : newContent,
    );
    for (const dl of diffLines) {
      if (dl.type === 'added' && dl.newLineNum !== undefined) {
        addedLines.add(dl.newLineNum);
      }
    }
  }

  // Grammar gate — checked DIRECTLY (rather than inferring from
  // extractBlocks returning null on both sides). The indirect check
  // misses the `isNew=true` / `isDeleted=true` case: empty source
  // short-circuits extractBlocks to `[]` even when the grammar is
  // missing, so a brand-new .sql / .css / .go file would falsely
  // present as "supported with empty changedQnames", and the empty
  // qname filter would then nuke the synthetic __file__ block on the
  // client → blank panel. Sniffing the grammar directly avoids that
  // ambiguity. See e.g. 009_create_llm_usage_logs.sql repro.
  if (!grammarForPath(filePath)) {
    return { addedLines };
  }

  const [oldBlocks, newBlocks] = await Promise.all([
    extractBlocks(isNew ? '' : oldContent, filePath),
    extractBlocks(isDeleted ? '' : newContent, filePath),
  ]);

  const rows = diffBlocks(oldBlocks ?? [], newBlocks ?? []);
  const changedQnames = new Set<string>();
  for (const r of rows) {
    if (r.changeKind === 'deleted') continue;
    changedQnames.add(r.qname);
  }
  return { changedQnames, addedLines };
}
