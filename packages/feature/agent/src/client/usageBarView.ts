// packages/feature/agent/src/client/usageBarView.ts
//
// WHICH FIGURES THE STATUS BAR SHOWS, and where the choice to show the rest is
// kept. Both decisions are here, pure, because both are the kind of rule that
// erodes into a template and then cannot be tested at all (jsdom has no layout,
// so nothing about this row is assertable by rendering it).
//
// WHY THE ROW COLLAPSES
// ---------------------
// It went out reading
//
//   5시간 21% (1h36m) · 7일 4% (5d4h) | 컨텍스트 28% (55k/200k) | 턴 입력: 275,350 |
//   출력: 23,902 | 캐시 적중: 75% | $2.9613
//
// and naby's reader is not a developer. Sorted by what that reader can ACT on:
//
//   plan windows   Actionable. "Can I keep working today." Stays visible.
//   conversation   Actionable AT THE TOP OF ITS RANGE — a full one is why a
//                  conversation needs compacting or a fresh tab, and naby has
//                  compaction. Stays visible.
//   turn input     Diagnostics. Nothing follows from either number.
//   output         Diagnostics.
//   input reused   Diagnostics. Nobody can raise it on purpose.
//   cost           Semi-meaningful and already hedged: on a subscription it is
//                  NOT a charge (NabySessionCost.tsx, `CostBasis` in
//                  src/engines/select.ts), which is why its tooltip has to
//                  explain the figure two ways. Behind the control.
//
// NOTHING IS DELETED. The diagnostics move behind an expand control and the
// expanded row is byte-for-byte what shipped before — a power user, and anyone
// debugging this, must still be able to read every figure that was ever here.
//
// THE RATE-LIMIT REFUSAL IS IN THE COLLAPSED SET, which is a judgement worth
// stating: it is not one of the six figures above, it is an ALERT — the only
// signal that a request was actually turned away — and hiding "you were just
// refused" behind a disclosure would be the one failure this row cannot afford.
// It is also almost always absent, so it costs the collapsed row nothing.
//
// NOTHING IS INVENTED AND NOTHING DEFAULTS TO ZERO. Presence is decided by the
// caller from the rules that already governed each figure (`usageWindowView`,
// `contextGauge`, `cacheBreakdown`, `totalCostUsd > 0`), and a figure that was
// not reported is ABSENT here, never a zero — the rule the gauge, the plan chip
// and the cache stat each already follow on their own.

/** One figure in the row. The ids are the row's own vocabulary, not translation
 *  keys: the component maps each to a literal `t()` call so the dictionary stays
 *  greppable (the same discipline `CacheLineKind` is under). */
export type UsageStatId =
  | 'plan'
  | 'rateLimited'
  | 'conversation'
  | 'turnInput'
  | 'output'
  | 'inputReused'
  | 'cost';

/**
 * Every figure, IN THE ORDER THE ROW DRAWS THEM. Right-aligned, so this reads
 * leftmost-first: account scope, then this conversation, then this turn.
 *
 * This constant is also the contract "the expanded row still contains every
 * figure the row has today" is asserted against — a figure dropped from the row
 * has to be dropped from here first, and that is a visible edit.
 */
export const USAGE_STATS: readonly UsageStatId[] = [
  'plan',
  'rateLimited',
  'conversation',
  'turnInput',
  'output',
  'inputReused',
  'cost',
];

/**
 * What survives the collapse. See the header for why each one earned its place;
 * the short version is that these are the only figures a non-developer can do
 * anything about.
 */
export const COLLAPSED_USAGE_STATS: readonly UsageStatId[] = [
  'plan',
  'rateLimited',
  'conversation',
];

/** Which figures the last turn actually reported. Booleans rather than values:
 *  this module decides VISIBILITY, and every figure's own show-or-not rule
 *  already lives in a tested helper of its own. */
export type UsagePresence = Readonly<Record<UsageStatId, boolean>>;

export interface UsageBarView {
  /**
   * Draw the row at all.
   *
   * False when the view that is CURRENTLY selected has nothing in it — which
   * collapsed means no plan reading, no context measurement and no refusal. An
   * empty bar with a lone disclosure triangle in it is chrome around nothing,
   * and this row's whole premise is that a figure nobody can act on should not
   * be taking a line of the window.
   *
   * The reader is not stranded by that: the preference is APP-WIDE (settings.json,
   * not per tab), so expanding once anywhere — any tab, any session where a plan
   * or a context reading exists — expands here too.
   */
  render: boolean;
  /** The remembered choice, echoed back so the control can render its state. */
  expanded: boolean;
  /** Show the control. Collapsed, only when something is actually hidden behind
   *  it: a control that reveals nothing is a lie about there being more. Expanded,
   *  always — it is the only way back. */
  canToggle: boolean;
  /** The figures to draw, in `USAGE_STATS` order. Present ∩ (expanded ? all :
   *  collapsed). */
  visible: readonly UsageStatId[];
  /** How many present figures the collapse is holding back. The control can say
   *  so, and a test can pin that "expanded shows everything" without enumerating
   *  the row twice. */
  hiddenCount: number;
}

/**
 * Which figures this row draws, given what the turn reported and whether the
 * user has asked for the detail.
 */
export function usageBarView(present: UsagePresence, expanded: boolean): UsageBarView {
  const reported = USAGE_STATS.filter((id) => present[id]);
  const collapsed = reported.filter((id) => COLLAPSED_USAGE_STATS.includes(id));
  const visible = expanded ? reported : collapsed;
  const hiddenCount = reported.length - collapsed.length;

  return {
    render: visible.length > 0,
    expanded,
    canToggle: expanded ? true : hiddenCount > 0,
    visible,
    hiddenCount,
  };
}

// ─────────────────────────────────────────────────────────
// Remembering the choice
// ─────────────────────────────────────────────────────────

/**
 * Where the expanded/collapsed choice is kept — in BOTH stores, which is one
 * mechanism and not two.
 *
 * THE HAZARD IS THE ONE `shared-utils/bootTheme.ts` DOCUMENTS: the desktop shell
 * boots Next on an EPHEMERAL port (`electron/next-server.ts` calls
 * `server.listen(0)`) and `localStorage` is scoped per ORIGIN, port included, so
 * every launch is a brand new empty store. A preference kept only there would
 * come back collapsed after every restart, and a power user would re-expand this
 * row once per launch forever.
 *
 * So the theme's resolution is used verbatim, exactly as `selectionChatOps`'
 * remembered popup size uses it:
 *
 *   `settings.json`  the durable copy, under a stable `COCKPIT_HOME`. Written
 *                    through on every toggle, read once when the fast path is
 *                    empty (i.e. once per launch).
 *   `localStorage`   the SYNCHRONOUS fast path, and what the first render reads:
 *                    a row that waited on a request would draw collapsed and then
 *                    jump open. A value here WINS — within a run it is the newer
 *                    of the two.
 *
 * One key names both, as `THEME_STORAGE_KEY` and `POPUP_SIZE_STORAGE_KEY` each
 * do: the `localStorage` key and the `settings.json` field.
 */
export const USAGE_DETAILS_STORAGE_KEY = 'usageBarDetailsExpanded';

/**
 * Collapsed until asked otherwise. The whole point of the change is that the
 * default row is the one a non-developer can read, so the diagnostics have to be
 * opt-in rather than opt-out.
 */
export const DEFAULT_USAGE_DETAILS_EXPANDED = false;

/**
 * Narrow an untrusted value — a `settings.json` field or a parsed `localStorage`
 * string — into the choice, or `null` for "nothing remembered".
 *
 * ONE RULE FOR BOTH STORES, which is the point: a hand-edited settings file and a
 * stale `localStorage` entry are the same hazard and must not be judged by two
 * different pieces of code.
 *
 * `null` is NOT `false`. The caller uses the difference: "never chosen" is what
 * lets the durable copy seed the fast path, while a remembered `false` is a
 * decision that must not be overwritten by a slower read.
 */
export function normalizeUsageDetails(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** What goes into `localStorage` under `USAGE_DETAILS_STORAGE_KEY`. */
export function serializeUsageDetails(expanded: boolean): string {
  return JSON.stringify(expanded);
}

/**
 * Read the choice back from the `localStorage` string.
 *
 * Total: a hand-edited, half-written or stale-shape value falls back to "nothing
 * remembered" rather than throwing while the row is being drawn.
 */
export function parseStoredUsageDetails(raw: string | null | undefined): boolean | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    return normalizeUsageDetails(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * What goes into `settings.json` — the same value under the same key, as a patch
 * for the merge-update `PUT /api/settings` performs. Built here rather than at the
 * call site so the durable copy cannot drift from the fast one, in key or in shape.
 */
export function usageDetailsSettingsPatch(expanded: boolean): Record<string, boolean> {
  return { [USAGE_DETAILS_STORAGE_KEY]: expanded };
}

/**
 * Read the choice back out of a whole `settings.json` payload — the seed used
 * when this origin's `localStorage` is empty, which after an app restart it
 * always is.
 */
export function usageDetailsFromSettings(settings: unknown): boolean | null {
  if (!settings || typeof settings !== 'object') return null;
  return normalizeUsageDetails((settings as Record<string, unknown>)[USAGE_DETAILS_STORAGE_KEY]);
}
