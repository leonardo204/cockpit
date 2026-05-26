/**
 * TF-IDF over identifier tokens, no training required.
 *
 * Two-tier tokenisation (P1-2):
 *   1. WORD tier — split on case transitions / underscores / slashes,
 *      lowercase, drop < 2 chars. Standard TF-IDF behaviour.
 *   2. CHAR N-GRAM tier — for each word ≥ 4 chars, also emit its 3- and
 *      4-character substrings as tokens with a fractional weight. This
 *      lets `validate` match `validator` (5 shared 3-grams) even though
 *      no word-level token overlaps, and lets `authentcate` (typo)
 *      match `authenticate` (8/10 3-grams overlap).
 *
 * The n-gram tier uses a smaller weight (NGRAM_WEIGHT = 0.5) so direct
 * word matches still outrank fuzzy substring overlaps. IDF naturally
 * suppresses generic n-grams ("ing", "tio") because they appear in
 * almost every document — no manual stop list needed.
 *
 * Pure JS, no deps. Memory cost is ~3-5× the word-only TF-IDF.
 */
import type { AnalyticsGraph, NodeId, NodeMeta } from './types';

const TOKEN_SPLIT = /[\s_./>:\\-]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g;
const MIN_TOKEN_LEN = 2;

// P1-2: character n-gram config.
const NGRAM_SIZES = [3, 4];
const NGRAM_WEIGHT = 0.5;
const MIN_LEN_FOR_NGRAM = 4; // shorter than 4 → noise dominates signal

export function tokenize(text: string): string[] {
  if (!text) return [];
  const raw = text.split(TOKEN_SPLIT);
  const out: string[] = [];
  for (const t of raw) {
    if (!t) continue;
    const low = t.toLowerCase();
    if (low.length < MIN_TOKEN_LEN) continue;
    out.push(low);
  }
  return out;
}

/** Generate character n-grams of length `n` from `s`. */
function* ngrams(s: string, n: number): Iterable<string> {
  if (s.length < n) return;
  for (let i = 0; i <= s.length - n; i++) yield s.slice(i, i + n);
}

interface WeightedToken {
  term: string;
  weight: number;
}

/** Emit all weighted tokens for a piece of text:
 *    - one entry per WORD token (weight 1.0)
 *    - one entry per n-gram of each word ≥ MIN_LEN_FOR_NGRAM (weight 0.5)
 *  The same term may appear multiple times — caller aggregates them. */
function weightedTokens(text: string): WeightedToken[] {
  const out: WeightedToken[] = [];
  for (const word of tokenize(text)) {
    out.push({ term: word, weight: 1.0 });
    if (word.length >= MIN_LEN_FOR_NGRAM) {
      for (const n of NGRAM_SIZES) {
        for (const ng of ngrams(word, n)) {
          out.push({ term: ng, weight: NGRAM_WEIGHT });
        }
      }
    }
  }
  return out;
}

function nodeTokensWeighted(meta: NodeMeta): WeightedToken[] {
  // We cache the *word* tokens on the meta (cheap, useful for other
  // consumers), but always recompute n-grams here because they're only
  // used by TfidfIndex and the index is built once.
  if (!meta.tokens) {
    meta.tokens = [
      ...tokenize(meta.name),
      ...tokenize(meta.qualifiedName),
      ...tokenize(meta.filePath.replace(/\.[^./]+$/, '')),
    ];
  }
  const out: WeightedToken[] = [];
  for (const word of meta.tokens) {
    out.push({ term: word, weight: 1.0 });
    if (word.length >= MIN_LEN_FOR_NGRAM) {
      for (const n of NGRAM_SIZES) {
        for (const ng of ngrams(word, n)) {
          out.push({ term: ng, weight: NGRAM_WEIGHT });
        }
      }
    }
  }
  return out;
}

export interface TfidfHit {
  node: NodeId;
  score: number;
}

export class TfidfIndex {
  private readonly df = new Map<string, number>(); // term → doc-frequency
  /** node → term → accumulated weight (multiple occurrences sum up). */
  private readonly tfByNode = new Map<NodeId, Map<string, number>>();
  /** L2 norm of each doc's tfidf vector (pre-computed for cosine sim). */
  private readonly normByNode = new Map<NodeId, number>();
  private readonly nDocs: number;

  constructor(graph: AnalyticsGraph) {
    this.nDocs = graph.nodes.size;
    // 1. Aggregate weighted tokens into per-node tf + global df.
    for (const [id, meta] of graph.nodes) {
      const weighted = nodeTokensWeighted(meta);
      const tf = new Map<string, number>();
      for (const { term, weight } of weighted) {
        tf.set(term, (tf.get(term) ?? 0) + weight);
      }
      this.tfByNode.set(id, tf);
      // df counts each unique term once per doc (regardless of weight).
      for (const term of tf.keys()) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
    // 2. Per-doc L2 norm for cosine similarity.
    for (const [id, tf] of this.tfByNode) {
      let s = 0;
      for (const [term, c] of tf) {
        const w = c * this.idf(term);
        s += w * w;
      }
      this.normByNode.set(id, Math.sqrt(s) || 1);
    }
  }

  private idf(term: string): number {
    const df = this.df.get(term) ?? 0;
    if (df === 0) return 0;
    // Smooth idf — handles tiny corpora gracefully. Generic n-grams
    // like "ing" / "tio" get very low idf automatically (they hit
    // hundreds of docs), which is exactly what we want.
    return Math.log((this.nDocs + 1) / (df + 1)) + 1;
  }

  /** Search by free-text query — cosine similarity against per-doc
   *  tfidf vectors. Returns top-K hits by score. */
  search(query: string, topK = 10): TfidfHit[] {
    const qWeighted = weightedTokens(query);
    if (qWeighted.length === 0) return [];
    const qtf = new Map<string, number>();
    for (const { term, weight } of qWeighted) {
      qtf.set(term, (qtf.get(term) ?? 0) + weight);
    }

    // Build query vector (only terms in the index).
    const qVec = new Map<string, number>();
    let qNormSq = 0;
    for (const [term, c] of qtf) {
      const w = c * this.idf(term);
      if (w === 0) continue;
      qVec.set(term, w);
      qNormSq += w * w;
    }
    const qNorm = Math.sqrt(qNormSq);
    if (qNorm === 0) return [];

    // Score every doc that shares at least one term with the query.
    const scores = new Map<NodeId, number>();
    for (const [node, tf] of this.tfByNode) {
      let dot = 0;
      for (const [term, qw] of qVec) {
        const c = tf.get(term);
        if (!c) continue;
        dot += qw * (c * this.idf(term));
      }
      if (dot > 0) {
        scores.set(node, dot / (qNorm * (this.normByNode.get(node) ?? 1)));
      }
    }
    const out: TfidfHit[] = [];
    for (const [node, score] of scores) out.push({ node, score });
    out.sort((a, b) => b.score - a.score);
    return topK > 0 ? out.slice(0, topK) : out;
  }
}
