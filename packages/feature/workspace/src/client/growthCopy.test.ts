import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 3 (P3-M5) — the growth panel's COPY has to exist in both locales.
 *
 * The panel and the check-in prompt are the two surfaces that explain the trust
 * meter to the user, and a missing key there fails silently: i18next falls back
 * to the English `defaultValue`, so a Korean user reads an English sentence in the
 * middle of a Korean panel and nothing errors. That is exactly the failure this
 * milestone must not ship — the regression explanation is the whole point of the
 * panel. A test is the only thing that catches it without clicking through.
 *
 * Scanned by reading the sources rather than by rendering: the keys are static
 * strings, so a parse is both cheaper and stricter than a render (it sees keys on
 * branches a single render never reaches).
 */

/** The `packages/` root — this file sits at packages/feature/workspace/src/client. */
const ROOT = join(__dirname, '../../../..');
const LOCALES = ['en', 'ko'] as const;

function dict(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, 'shared/i18n/locales', `${locale}.json`), 'utf8'));
}

function lookup(d: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, part) => {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      return (cur as Record<string, unknown>)[part];
    }
    return undefined;
  }, d);
}

/** Literal `t('a.b')` keys in a source file. Template keys (`t(`x.${y}`)`) are
 *  dynamic and enumerated explicitly below instead. */
function literalKeys(relPath: string): string[] {
  const src = readFileSync(join(ROOT, relPath), 'utf8');
  return [...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.-]+)'/g)].map((m) => m[1]!);
}

/** The keys built by template interpolation, spelled out so they are covered too. */
const DYNAMIC_KEYS = [
  // The interview's labels are looked up from ids the SERVER sends, so they are
  // spelled out here rather than being visible as literals in the component.
  ...['address', 'language', 'style', 'rule'].flatMap((q) => [
    `bootstrap.q.${q}`,
    `bootstrap.q.${q}Hint`,
  ]),
  ...(['egg', 'larva', 'pupa', 'butterfly'] as const).flatMap((s) => [
    `growth.stage.${s}`,
    `growth.meaning.${s}`,
  ]),
  'growth.excluded.one-real-option',
  'growth.excluded.repeat-question',
];

const SOURCES = [
  'feature/workspace/src/client/GrowthPanel.tsx',
  // settings-ia-reorg §3.2: most of the panel's copy moved into the report
  // overlay. Same keys, same sentences, one file further out — so the scan has
  // to follow them, or two thirds of this milestone's copy would stop being
  // checked the moment it moved.
  'feature/workspace/src/client/GrowthReportModal.tsx',
  'feature/agent/src/client/CheckinPrompt.tsx',
  // P3-M6: the export confirmation is the same kind of surface — it explains to
  // the user what is about to leave their machine, and an English fallback there
  // would be worse than in the panel, not better.
  'feature/workspace/src/client/AgentExportButton.tsx',
  'feature/workspace/src/client/AgentImportButton.tsx',
  // P15-07: the cold-start interview is the very first Korean a new user reads.
  'feature/workspace/src/client/BootstrapCard.tsx',
  // P3-M8b: the memory review queue. Its new copy explains a switch that lets
  // naby confirm memories WITHOUT being asked — an English fallback on that
  // sentence would leave a Korean user unable to read what they are turning on.
  'feature/workspace/src/client/NabyMemoryReview.tsx',
];

describe('growth, check-in and export copy is complete in every locale', () => {
  for (const locale of LOCALES) {
    it(`${locale}: every key the panel and the prompt ask for exists`, () => {
      const d = dict(locale);
      const missing: string[] = [];
      for (const key of [...SOURCES.flatMap(literalKeys), ...DYNAMIC_KEYS]) {
        const value = lookup(d, key);
        if (typeof value !== 'string' || !value.trim()) missing.push(key);
      }
      expect(missing).toEqual([]);
    });

    it(`${locale}: the regression sentences keep their placeholders`, () => {
      const d = dict(locale);
      // A translation that dropped `{{misses}}` would render "of the last went
      // differently" — grammatical, and useless. The counts ARE the explanation:
      // they are what the user can check against their own conversation.
      const required: Array<[string, string[]]> = [
        ['growth.reason.notMeasured', ['{{needed}}']],
        ['growth.reason.newPattern', ['{{misses}}', '{{trials}}', '{{taskType}}']],
        ['growth.reason.accuracyDrop', ['{{misses}}', '{{trials}}']],
        ['growth.reason.accuracyGain', ['{{misses}}', '{{trials}}']],
        ['growth.eggHint', ['{{needed}}']],
        // The egg line AFTER a fast-growth session. All three counts are the
        // point of the sentence: a translation that dropped {{drills}} would tell
        // a user who just answered three practice questions the same thing it told
        // them before the session, which is the exact silence this key exists to
        // end (fast-evolution §3.4).
        ['growth.eggHintWithDrills', ['{{needed}}', '{{drills}}', '{{drillHits}}']],
        ['growth.tripwireBlocked', ['{{count}}']],
        ['growth.axis.hitRateValue', ['{{hits}}', '{{trials}}']],
        ['growth.calibrationGood', ['{{count}}']],
        ['growth.calibrationPoor', ['{{count}}']],
        ['growth.askQuality', ['{{warranted}}', '{{asked}}', '{{silent}}', '{{missed}}']],
        ['agentExport.included', ['{{count}}']],
        ['agentExport.ledger', ['{{count}}']],
        ['agentExport.stage', ['{{stage}}']],
        ['agentExport.droppedProposed', ['{{count}}']],
        ['agentExport.droppedSession', ['{{count}}']],
        ['agentExport.droppedSecret', ['{{count}}']],
        ['agentExport.redacted', ['{{count}}']],
        ['agentImport.renamed', ['{{from}}']],
        ['agentImport.facts', ['{{count}}']],
        ['agentImport.ledger', ['{{count}}']],
        ['agentImport.claimed', ['{{stage}}']],
        ['agentImport.skipped', ['{{count}}']],
        ['agentImport.done', ['{{name}}', '{{count}}']],
        ['bootstrap.saved', ['{{count}}']],
        ['bootstrap.savedWithSkips', ['{{count}}', '{{skipped}}']],
        // P3-M8b: both counts are the whole content of their sentence. "Seen in
        // sessions" and "once different sessions have said the same thing" are
        // grammatical and say nothing.
        ['memoryReview.corroborated', ['{{count}}']],
        ['memoryReview.autoConfirmHint', ['{{count}}']],
        // P3-M8c: every value in the learning block IS a number. A translation
        // that dropped the placeholder would render an empty cell beside a label,
        // which reads as "zero" rather than as a missing translation.
        ['growth.learning.confirmedValue', ['{{count}}']],
        ['growth.learning.proposedValue', ['{{count}}']],
        ['growth.learning.corroboratedValue', ['{{count}}']],
        ['growth.learning.taskTypesValue', ['{{count}}']],
        ['growth.learning.byScopeValue', ['{{user}}', '{{project}}']],
        ['growth.learning.lastReflection', ['{{when}}']],
        // P3-M8d: the implicit axis. All three placeholders are load-bearing —
        // the two counts are what the user can check against their own history,
        // and {{weight}} is the SERVER's constant. A translation that spelled the
        // weight out in prose instead would go quietly wrong the day it changes,
        // which is the same failure the corroboration threshold avoids by being
        // interpolated rather than typed into the sentence.
        ['growth.implicitAxis', ['{{reviewed}}', '{{stood}}', '{{weight}}']],
        // WHERE THE PENDING COUNT IS SPOKEN, now that it is spoken in exactly one
        // place. A bare "1" on the memory nav row was reported as unreadable
        // ("'1'은 무슨 의미죠?"); the tooltip that was meant to answer it never
        // rendered in Electron, so the badge went and the inbox heading kept the
        // count. A translation that dropped the placeholder would leave "확인할
        // 것" over a list with no number on the screen at all.
        ['memoryReview.summaryPendingCount', ['{{count}}']],
      ];
      for (const [key, placeholders] of required) {
        const value = String(lookup(d, key) ?? '');
        for (const p of placeholders) {
          expect(value, `${locale} ${key} must interpolate ${p}`).toContain(p);
        }
      }
    });
  }

  it('the stage names are actually translated, not left as the code word', () => {
    const ko = dict('ko');
    expect(lookup(ko, 'growth.stage.egg')).toBe('알');
    expect(lookup(ko, 'growth.stage.larva')).toBe('애벌레');
    expect(lookup(ko, 'growth.stage.pupa')).toBe('번데기');
    expect(lookup(ko, 'growth.stage.butterfly')).toBe('나비');
  });

  it('P3-M8c: the learning block disowns the gauge, in every locale', () => {
    // THE ONE SENTENCE THIS MILESTONE CANNOT SHIP WITHOUT (continuous-learning
    // §6.3; trust-meter §9.2 rule 2 — two numbers on one screen must never
    // disagree). The learning block prints counts directly beneath a gauge that
    // deliberately ignores counts, so it has to say which question each answers.
    // Falling back to English here would leave a Korean user reading a number
    // they cannot place, which is exactly the confusion §9.2 exists to prevent.
    for (const locale of LOCALES) {
      const line = String(lookup(dict(locale), 'growth.learning.notTheGauge') ?? '');
      expect(line.length).toBeGreaterThan(20);
      // It must NAME the butterfly judgement, not merely gesture at "the score".
      expect(line).toMatch(locale === 'ko' ? /나비/ : /butterfly/i);
      // And it must be a DENIAL. A sentence that only describes the counts would
      // pass the length check while saying nothing about the gate.
      expect(line).toMatch(locale === 'ko' ? /않습니다|않는다/ : /\bnot\b/i);
    }
  });

  it('P3-M8c: the learning labels are translated, not left in English', () => {
    // A Korean panel with English labels beside Korean ones is how a fallback
    // hides: nothing errors, and the block reads as a debug surface.
    const ko = dict('ko');
    for (const key of ['title', 'confirmed', 'proposed', 'corroborated', 'taskTypes']) {
      const value = String(lookup(ko, `growth.learning.${key}`) ?? '');
      expect(value, `growth.learning.${key} must be Korean`).toMatch(/[가-힣]/);
    }
  });

  it('P3-M8d: the implicit axis admits it is weaker evidence, and the trust statement stops saying "only"', () => {
    // TWO SENTENCES THAT HAVE TO AGREE WITH EACH OTHER (trust-meter §9.2 rule 2).
    // The implicit axis moves the gauge, so the panel cannot describe it the way
    // it describes the learning block ("this does not enter the judgement") — it
    // has to say the opposite AND say it counts for less. And `howItMoves`, the
    // line a user checks the whole panel against, said growth moves ONLY on
    // answered check-ins; leaving that in place would make the disclaimer itself
    // the false statement on the screen.
    for (const locale of LOCALES) {
      const d = dict(locale);
      const implicit = String(lookup(d, 'growth.implicitAxis') ?? '');
      expect(implicit.length).toBeGreaterThan(40);
      // It must NAME the weakness rather than merely reporting two counts.
      expect(implicit).toMatch(locale === 'ko' ? /약한|적은/ : /weaker|less/i);
      const howItMoves = String(lookup(d, 'growth.howItMoves') ?? '');
      expect(howItMoves).not.toMatch(/moves only when|만 셉니다|만 센다/);
    }
  });

  it('the larva copy does not claim accuracy the stage cannot promise', () => {
    // A larva can sit at 0%: measured, and getting them wrong. Copy that said "it
    // is starting to guess right" would contradict the gauge next to it, the same
    // trap the egg-0% and blocked-99% rules exist to avoid.
    for (const locale of LOCALES) {
      const meaning = String(lookup(dict(locale), 'growth.meaning.larva') ?? '');
      expect(meaning).not.toMatch(/starting to guess right|맞히기 시작/);
      expect(meaning.length).toBeGreaterThan(10);
    }
  });
});
