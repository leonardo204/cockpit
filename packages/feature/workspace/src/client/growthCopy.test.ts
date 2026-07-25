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
  ...(['egg', 'larva', 'pupa', 'butterfly'] as const).flatMap((s) => [
    `growth.stage.${s}`,
    `growth.meaning.${s}`,
  ]),
  'growth.excluded.one-real-option',
  'growth.excluded.repeat-question',
];

const SOURCES = [
  'feature/workspace/src/client/GrowthPanel.tsx',
  'feature/agent/src/client/CheckinPrompt.tsx',
];

describe('growth + check-in copy is complete in every locale', () => {
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
        ['growth.tripwireBlocked', ['{{count}}']],
        ['growth.axis.hitRateValue', ['{{hits}}', '{{trials}}']],
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
