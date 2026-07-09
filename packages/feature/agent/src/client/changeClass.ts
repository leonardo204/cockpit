/**
 * Heuristic classification of changed files for the snapshot diff viewer:
 * mark tool calls (and individual files) that touched ONLY tests or ONLY
 * docs, so reviewers can skim past non-critical steps in the timeline.
 *
 * Deliberately conservative:
 * - a call is classified only when EVERY changed file falls in the same
 *   class — a mixed test+source commit is a critical change and gets no mark
 * - i18n locale files count as code (they affect the running UI)
 * - no `chore` class: config/lockfile boundaries are too fuzzy, and
 *   mislabeling a critical config change as non-critical is worse than
 *   leaving it unmarked
 */

export type ChangeClass = 'test' | 'docs';

const TEST_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /\.(test|spec)\.[^/]+$/,
];

const DOCS_PATTERNS: ReadonlyArray<RegExp> = [
  /\.(md|mdx)$/i,
  /(^|\/)docs\//,
  /(^|\/)README[^/]*$/i,
  /(^|\/)LICENSE[^/]*$/i,
  /(^|\/)CHANGELOG[^/]*$/i,
];

/** Classify one cwd-relative path; null = regular (critical) code. */
export function classifyPath(path: string): ChangeClass | null {
  if (TEST_PATTERNS.some((re) => re.test(path))) return 'test';
  if (DOCS_PATTERNS.some((re) => re.test(path))) return 'docs';
  return null;
}

/** Classify a whole change set: non-null only when every file agrees. */
export function classifyFiles(paths: ReadonlyArray<string>): ChangeClass | null {
  if (paths.length === 0) return null;
  const first = classifyPath(paths[0]);
  if (first === null) return null;
  return paths.every((p) => classifyPath(p) === first) ? first : null;
}
