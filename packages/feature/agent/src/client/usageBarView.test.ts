import { describe, it, expect } from 'vitest';
import {
  COLLAPSED_USAGE_STATS,
  DEFAULT_USAGE_DETAILS_EXPANDED,
  USAGE_DETAILS_STORAGE_KEY,
  USAGE_STATS,
  normalizeUsageDetails,
  parseStoredUsageDetails,
  serializeUsageDetails,
  usageBarView,
  usageDetailsFromSettings,
  usageDetailsSettingsPatch,
  type UsagePresence,
  type UsageStatId,
} from './usageBarView';

/**
 * THE ROW COLLAPSES TO WHAT A NON-DEVELOPER CAN ACT ON, and this is where that
 * claim is held to account. jsdom has no layout, so nothing about the rendered
 * row is assertable by mounting it — but the whole decision is pure, which is
 * why it was extracted here in the first place.
 *
 * The contracts worth pinning are the ones the module's header promises out
 * loud: nothing is deleted (expanded is still every figure the row has),
 * nothing is invented (an unreported figure never appears, in either state),
 * the control never reveals nothing, and the remembered choice survives a
 * restart in a store that is wiped every launch.
 */

/** Everything reported — the turn that carries every figure at once. */
const ALL: UsagePresence = {
  plan: true,
  rateLimited: true,
  conversation: true,
  turnInput: true,
  output: true,
  inputReused: true,
  cost: true,
};

const only = (...ids: UsageStatId[]): UsagePresence =>
  Object.fromEntries(USAGE_STATS.map((id) => [id, ids.includes(id)])) as UsagePresence;

const NONE = only();

describe('the collapsed set is the actionable one', () => {
  it('keeps the plan, the refusal and the conversation, and nothing else', () => {
    // Stated as an equality rather than a series of `toContain`s: adding a
    // figure to the default row is a decision about what a non-developer is
    // asked to read, and it should not be possible to make it quietly.
    expect([...COLLAPSED_USAGE_STATS]).toEqual(['plan', 'rateLimited', 'conversation']);
  });

  it('holds the refusal in the collapsed set, alert that it is', () => {
    // Not one of the six figures — the only signal a request was actually turned
    // away. Hiding it behind a disclosure is the one failure this row cannot
    // afford, so it is asserted on its own rather than left to the list above.
    expect(COLLAPSED_USAGE_STATS).toContain('rateLimited');
  });

  it('is a subset of the row, in the row’s own order', () => {
    for (const id of COLLAPSED_USAGE_STATS) expect(USAGE_STATS).toContain(id);
    const order = COLLAPSED_USAGE_STATS.map((id) => USAGE_STATS.indexOf(id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('starts collapsed', () => {
    // The point of the change is that the DEFAULT row is the readable one. An
    // opt-out default would leave every existing install exactly as it was.
    expect(DEFAULT_USAGE_DETAILS_EXPANDED).toBe(false);
  });
});

describe('nothing is deleted', () => {
  it('expanded draws every figure the row has, in row order', () => {
    // The "nothing is deleted" guarantee, asserted against the constant — so a
    // figure dropped from the row has to be dropped from USAGE_STATS first, and
    // that is a visible edit rather than a disappearance.
    expect(usageBarView(ALL, true).visible).toEqual(USAGE_STATS);
  });

  it('expanded is a superset of collapsed, never a different row', () => {
    // Expanding may only ADD. If the two states could disagree about a figure,
    // "nothing is deleted" would hold for the constant and not for the reader.
    for (const present of [ALL, only('plan', 'cost'), only('conversation', 'turnInput')]) {
      const open = usageBarView(present, true).visible;
      for (const id of usageBarView(present, false).visible) expect(open).toContain(id);
    }
  });

  it('counts what the COLLAPSE holds back, not what is hidden right now', () => {
    // Deliberately state-independent: it is the figure the control puts on
    // itself ("+4"), and it has to read the same in the instant before the
    // toggle and the instant after — the component is what decides to stop
    // printing it once the row is open.
    expect(usageBarView(ALL, false).hiddenCount).toBe(4);
    expect(usageBarView(ALL, true).hiddenCount).toBe(4);
  });

  it('collapsed keeps every figure reachable — the control is always there', () => {
    // Expanded, the control is the only way back, so it may never be withdrawn.
    expect(usageBarView(ALL, true).canToggle).toBe(true);
    expect(usageBarView(NONE, true).canToggle).toBe(true);
  });
});

describe('nothing is invented', () => {
  it('an unreported figure is absent in both states', () => {
    const present = only('conversation', 'output');
    expect(usageBarView(present, true).visible).toEqual(['conversation', 'output']);
    expect(usageBarView(present, false).visible).toEqual(['conversation']);
  });

  it('counts only what was reported as hidden', () => {
    // Two diagnostics reported, one collapsed figure: the control speaks for the
    // two, never for the five the row could theoretically carry.
    const view = usageBarView(only('plan', 'output', 'cost'), false);
    expect(view.visible).toEqual(['plan']);
    expect(view.hiddenCount).toBe(2);
  });

  it('draws the collapsed figures in row order regardless of presence order', () => {
    expect(usageBarView(ALL, false).visible).toEqual([...COLLAPSED_USAGE_STATS]);
  });
});

describe('the row draws only when it has something in it', () => {
  it('does not render a bar holding nothing but its own control', () => {
    // Collapsed with only diagnostics reported: an empty row with a lone
    // disclosure triangle is chrome around nothing, and this whole change is
    // about not spending a line of the window on that.
    const view = usageBarView(only('turnInput', 'output', 'cost'), false);
    expect(view.visible).toEqual([]);
    expect(view.render).toBe(false);
  });

  it('does not render when the turn reported nothing at all', () => {
    expect(usageBarView(NONE, false).render).toBe(false);
    expect(usageBarView(NONE, true).render).toBe(false);
  });

  it('renders as soon as one collapsed figure is there', () => {
    expect(usageBarView(only('conversation'), false).render).toBe(true);
    expect(usageBarView(only('rateLimited'), false).render).toBe(true);
  });
});

describe('the control never promises what it cannot show', () => {
  it('is withheld when the collapse is holding nothing back', () => {
    // Everything reported is already visible: a control that reveals nothing is
    // a lie about there being more.
    const view = usageBarView(only('plan', 'conversation'), false);
    expect(view.hiddenCount).toBe(0);
    expect(view.canToggle).toBe(false);
  });

  it('appears as soon as one diagnostic is being held back', () => {
    expect(usageBarView(only('plan', 'cost'), false).canToggle).toBe(true);
  });

  it('echoes the remembered choice back for the control to render its state', () => {
    expect(usageBarView(ALL, false).expanded).toBe(false);
    expect(usageBarView(ALL, true).expanded).toBe(true);
  });
});

describe('remembering the choice', () => {
  it('names both stores with one key', () => {
    // The localStorage key and the settings.json field, as THEME_STORAGE_KEY and
    // POPUP_SIZE_STORAGE_KEY each do — two names would be two ways to drift.
    expect(USAGE_DETAILS_STORAGE_KEY).toBe('usageBarDetailsExpanded');
    expect(usageDetailsSettingsPatch(true)).toEqual({ [USAGE_DETAILS_STORAGE_KEY]: true });
    expect(usageDetailsSettingsPatch(false)).toEqual({ [USAGE_DETAILS_STORAGE_KEY]: false });
  });

  it('round-trips through the fast path', () => {
    expect(parseStoredUsageDetails(serializeUsageDetails(true))).toBe(true);
    expect(parseStoredUsageDetails(serializeUsageDetails(false))).toBe(false);
  });

  it('round-trips through the durable copy', () => {
    expect(usageDetailsFromSettings(usageDetailsSettingsPatch(true))).toBe(true);
    expect(usageDetailsFromSettings(usageDetailsSettingsPatch(false))).toBe(false);
  });

  it('reads nothing remembered as null, which is NOT false', () => {
    // The caller uses the difference: "never chosen" is what lets the durable
    // copy seed the fast path, while a remembered `false` is a decision that a
    // slower read must not overwrite.
    expect(parseStoredUsageDetails(null)).toBeNull();
    expect(parseStoredUsageDetails(undefined)).toBeNull();
    expect(parseStoredUsageDetails('')).toBeNull();
    expect(usageDetailsFromSettings({})).toBeNull();
    expect(parseStoredUsageDetails('false')).toBe(false);
  });

  it('is total on a hand-edited or stale value', () => {
    // It runs while the row is being drawn. Throwing here would take the status
    // bar down over a preference.
    for (const raw of ['{', 'yes', '1', '"true"', 'null', '[]', '{"a":1}']) {
      expect(parseStoredUsageDetails(raw)).toBeNull();
    }
  });

  it('judges a settings file and a localStorage entry by one rule', () => {
    // A hand-edited settings field and a stale storage entry are the same
    // hazard, and must not be judged by two different pieces of code.
    for (const bad of ['true', 1, 0, null, undefined, {}, []]) {
      expect(normalizeUsageDetails(bad)).toBeNull();
    }
    expect(normalizeUsageDetails(true)).toBe(true);
    expect(normalizeUsageDetails(false)).toBe(false);
  });

  it('survives a settings payload that is not an object', () => {
    for (const bad of [null, undefined, 'nope', 42, []]) {
      expect(usageDetailsFromSettings(bad)).toBeNull();
    }
  });
});
