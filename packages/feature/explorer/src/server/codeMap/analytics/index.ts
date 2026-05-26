/**
 * Analytics module barrel — re-exports the things route handlers and
 * the codeIndex precompute hook need.
 */
export * from './types';
export { buildAnalyticsGraph, firstSymbolOfFile } from './graph';
export { pagerank, personalizedPageRank } from './pagerank';
export type { PageRankOptions, PPROptions, PPRResult } from './pagerank';
export { TfidfIndex, tokenize } from './tfidf';
export type { TfidfHit } from './tfidf';
export {
  getAnalytics,
  invalidateAnalytics,
  precomputeAnalytics,
  getOrTriggerAnalytics,
} from './cache';
export type { AnalyticsEntry } from './cache';
export { buildContext } from './contextBuilder';
export type {
  ContextHit,
  ContextInput,
  ContextResponse,
  ContextSeedDebug,
  ContextSignal,
} from './contextBuilder';
export { buildRelated } from './relatedBuilder';
export type { Relation, RelatedHit, RelatedInput, RelatedResponse } from './relatedBuilder';
export { scoreImpact } from './impactScorer';
export type { RiskInput, RiskNode, RiskResponse, TestSuggestion } from './impactScorer';
export { findAffected, isTestFile } from './affected';
export type {
  AffectedInput,
  AffectedResponse,
  AffectedByInput,
  AffectedTestEntry,
  AffectedStats,
} from './affected';
