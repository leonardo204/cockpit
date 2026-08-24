import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../../shared/i18n/locales/en.json';
import ko from '../../../../shared/i18n/locales/ko.json';
import { USAGE_STATS, type UsageStatId } from './usageBarView';

/**
 * THE ROW ACTUALLY GOES THROUGH `usageBarView`.
 *
 * Source assertions, for the reason the rest of this row's suites give: jsdom has
 * no layout and no pointer, so neither the collapse nor the control can be seen by
 * mounting anything. What is at risk is the WIRING — a figure gated on its own old
 * condition and therefore never collapsing, or the preference kept in the one store
 * that is wiped on every launch — and that is readable in the file.
 *
 * The decision itself is not tested here. It is pure, and usageBarView.test.ts owns
 * it.
 */

const DIR = __dirname;
const BAR = readFileSync(join(DIR, 'TokenUsageBar.tsx'), 'utf8');
const chat = (dict: unknown): Record<string, string> =>
  (dict as { chat: Record<string, string> }).chat;

describe('every figure is drawn through the view', () => {
  it.each(USAGE_STATS as readonly UsageStatId[])('%s is gated on shows()', (id) => {
    // A figure left on its own condition would keep drawing while the row was
    // collapsed — the one failure mode of this change that looks like nothing is
    // wrong until you compare the row with the list.
    expect(BAR).toContain(`shows('${id}')`);
  });

  it('states presence from the rules that already governed each figure', () => {
    // Not re-derived here. Each of these is the show-or-not the figure already
    // had; a second copy of any of them is how the row and its tooltip start
    // disagreeing about whether a number exists.
    expect(BAR).toContain('plan: showUsage');
    expect(BAR).toContain('rateLimited: rateLimitRejected');
    expect(BAR).toContain('conversation: gauge.show');
    expect(BAR).toContain('inputReused: cache.show');
    expect(BAR).toContain('cost: tokenUsage.totalCostUsd > 0');
  });

  it('draws nothing rather than a bar containing only its own control', () => {
    expect(BAR).toContain('if (!view.render) return null;');
  });

  it('withholds the control when it would reveal nothing', () => {
    expect(BAR).toContain('{view.canToggle && (');
    // Collapsed it says how many, because a bare chevron does not.
    expect(BAR).toContain('{!expanded && <span>+{view.hiddenCount}</span>}');
  });
});

describe('the choice survives a restart', () => {
  it('is kept in BOTH stores, not just the one that is wiped every launch', () => {
    // The desktop shell boots Next on an ephemeral port, so `localStorage` is
    // scoped to an origin that dies with the process. A preference kept only
    // there resets on every launch — the complaint the popup size already had.
    expect(BAR).toMatch(/window\.localStorage\.getItem\(USAGE_DETAILS_STORAGE_KEY\)/);
    expect(BAR).toMatch(/window\.localStorage\.setItem\(USAGE_DETAILS_STORAGE_KEY/);
    expect(BAR).toContain('saveAgentSettings(usageDetailsSettingsPatch(expanded))');
    expect(BAR).toContain('usageDetailsFromSettings(exit.value)');
  });

  it('reads the fast path synchronously, so the first render is the right one', () => {
    // A row that waited on the request would draw collapsed and then jump open.
    expect(BAR).toContain('useState<boolean | null>(() =>\n    readStoredUsageDetails(),\n  )');
  });

  it('lets a live choice outrank the slower durable read', () => {
    // "Never chosen" is what may be seeded; a remembered value — `false` included
    // — is a decision, and a row that reopened under the hand that just closed it
    // would be worse than not remembering at all.
    const seed = /const stored = await loadPersistedUsageDetails\(\);[\s\S]{0,600}?setStoredExpanded\(stored\);/.exec(
      BAR,
    )?.[0];
    expect(seed, 'the seeding effect is gone — did the persistence change?').toBeDefined();
    expect(seed).toContain('readStoredUsageDetails() !== null) return;');
  });

  it('never lets a preference take the status bar down', () => {
    // `localStorage` throws on mere ACCESS when storage is disabled, and the
    // settings request can simply fail. Both reads are total.
    expect(BAR).toMatch(/function readStoredUsageDetails[\s\S]{0,400}?catch \{\s*\n\s*return null;/);
    expect(BAR).toContain("if (exit._tag !== 'Success') return null;");
    // Fire-and-forget, the shape `persistTheme` and `persistPopupSize` use.
    expect(BAR).toContain('Effect.orElse(() => Effect.void)');
  });
});

describe('the control says what it does, in both languages', () => {
  it('names the figures instead of saying "details"', () => {
    // A chevron marked "자세히" gives the reader no reason to press it — and the
    // premise of hiding these four is that most people do not know they are what
    // they are looking for.
    for (const dict of [en, ko]) {
      expect(chat(dict).usageDetailsShow).toBeTruthy();
      expect(chat(dict).usageDetailsHide).toBeTruthy();
    }
    expect(chat(en).usageDetailsShow).toContain('cache reuse');
    expect(chat(ko).usageDetailsShow).toContain('캐시 재사용');
    expect(chat(ko).usageDetailsShow).toContain('비용');
  });

  it('reaches a Korean user as Korean, not as a raw key path', () => {
    for (const key of ['usageDetailsShow', 'usageDetailsHide']) {
      expect(BAR).toContain(`t('chat.${key}'`);
      expect(chat(ko)[key]).not.toBe(chat(en)[key]);
    }
  });

  it('is reachable without a pointer', () => {
    // The visible content is a chevron and a numeral; a screen reader cannot make
    // a verb out of either, so the label is not optional.
    expect(BAR).toContain('aria-label={usageDetailsLabel()}');
    expect(BAR).toContain('aria-expanded={expanded}');
    expect(BAR).toContain('type="button"');
  });
});
