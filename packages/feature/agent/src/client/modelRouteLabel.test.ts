import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chipLabelFor, routeReasonKey, routeTooltip, tierDisplayName } from './modelRouteLabel';
import { CLAUDE_MODELS, claudeOptionsFrom, type ModelOption } from './modelCatalog';
import type { ModelRoute } from './types';

/**
 * THE CHIP HAS TO SHOW THAT THE ROUTER IS RUNNING.
 *
 * "Every request shows the same model" is the complaint the auto feature exists
 * to answer (specs/model-auto-routing.md §1), so a chip that says a flat "Auto"
 * forever fails the feature even when the routing is perfect. These pin the
 * composition — which is pure, and is the half that a mounted test could not
 * reach anyway (the live catalog arrives from a fetch).
 */

// The live catalog of a signed-in machine, verbatim from a probe (spec §3).
const LIVE: ModelOption[] = claudeOptionsFrom([
  { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5[1m]' },
  { value: 'opus[1m]', displayName: 'Opus', resolvedModel: 'claude-opus-5[1m]' },
  { value: 'claude-fable-5-1[1m]', displayName: 'Fable', resolvedModel: 'claude-fable-5-1[1m]' },
  { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5' },
  { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-5' },
]);

const route = (tier: ModelRoute['tier'], reason: ModelRoute['reason'] = 'default'): ModelRoute => ({
  requested: 'auto',
  tier,
  reason,
});

describe('chipLabelFor', () => {
  it('names the tier naby picked for this turn', () => {
    expect(chipLabelFor('auto', route('sonnet', 'chat'), LIVE)).toBe('Auto · Sonnet');
    expect(chipLabelFor('auto', route('opus', 'build-ask'), LIVE)).toBe('Auto · Opus');
  });

  it('says plain "Auto" until a turn has actually been routed', () => {
    // Before the first send of a session there is nothing to report, and a chip
    // that guessed a tier would be claiming a decision nobody made.
    expect(chipLabelFor('auto', null, LIVE)).toBe('Auto');
    expect(chipLabelFor('auto', undefined, LIVE)).toBe('Auto');
  });

  it('leaves an EXPLICIT pick alone, even while a route is still in hand', () => {
    // The user pinned a model; the chip must say that model. A stale route
    // relabelling it would read as the router overriding an explicit choice —
    // which is the one thing principle 1 forbids.
    expect(chipLabelFor('sonnet', route('opus'), LIVE)).toBe('Sonnet');
    // Including the SDK's own default row, which is a pick like any other.
    expect(chipLabelFor('default', route('opus'), LIVE)).toBe('Default (recommended)');
  });

  it('works off the CURATED list too (before the first probe answers)', () => {
    expect(chipLabelFor('auto', route('haiku', 'chat'), CLAUDE_MODELS)).toBe('Auto · Haiku');
  });

  it('falls back to the caller’s label for a value the list does not hold', () => {
    expect(chipLabelFor('gpt-5.6-sol', null, [], 'GPT-5.6 Sol')).toBe('GPT-5.6 Sol');
    expect(chipLabelFor('', null, [])).toBe('Default');
  });
});

describe('tierDisplayName — the tier as the live catalog names it', () => {
  it('maps opus to the 1M row, the way the router picks its value', () => {
    // opus must stay `opus[1m]`: today's `default` resolves to that, and turning
    // auto on may not shrink the window from 1M to 200k (spec §4.3).
    expect(tierDisplayName('opus', LIVE)).toBe('Opus');
  });

  it('finds fable by PREFIX, because its value carries a version', () => {
    // `claude-fable-5-1[1m]` — an exact match on `fable` would miss it and the
    // chip would fall back to the tier word for the one tier that has a name.
    expect(tierDisplayName('fable', LIVE)).toBe('Fable');
  });

  it('never resolves a tier to the `default` row', () => {
    // `default` resolves to opus on this machine, and "Auto · Default
    // (recommended)" explains nothing about what answered.
    const onlyDefault: ModelOption[] = [{ value: 'default', label: 'Default (recommended)' }];
    expect(tierDisplayName('opus', onlyDefault)).toBe('Opus');
    expect(tierDisplayName('sonnet', onlyDefault)).toBe('Sonnet');
  });

  it('capitalises the tier when the catalog has no row for it', () => {
    // Not signed in, or a plan without that model: the chip still has to say
    // something, and the raw slug (`opus[1m]`) reads like a bug.
    expect(tierDisplayName('haiku', [])).toBe('Haiku');
    expect(chipLabelFor('auto', route('fable', 'plan-mode'), [{ value: 'auto', label: 'Auto' }])).toBe(
      'Auto · Fable',
    );
  });
});

describe('the tooltip', () => {
  it('asks i18n for the reason by its code', () => {
    expect(routeReasonKey(route('fable', 'plan-mode'))).toBe('modelSwitcher.route.plan-mode');
    expect(routeReasonKey(route('opus', 'window-fit'))).toBe('modelSwitcher.route.window-fit');
  });

  it('appends the id that ACTUALLY served the turn, once the result says so', () => {
    // The label keeps the tier name; the exact build goes here, where there is
    // room for it (spec §4.6).
    expect(routeTooltip('a short exchange', 'claude-haiku-5')).toBe('a short exchange · claude-haiku-5');
  });

  it('is just the reason until then', () => {
    expect(routeTooltip('a short exchange')).toBe('a short exchange');
    expect(routeTooltip('a short exchange', undefined)).toBe('a short exchange');
  });

  it('every reason code the router can emit has a line in BOTH locales', () => {
    // A missing key renders the raw code ("budget-cap") in the tooltip — which is
    // the failure this catches, and i18n's defaultValue would hide it in en.
    const REASONS: ModelRoute['reason'][] = [
      'plan-mode',
      'design-ask',
      'build-ask',
      'deep-ask',
      'routine',
      'full-mode',
      'chat',
      'default',
      'sticky',
      'window-fit',
      'budget-cap',
    ];
    const locales = join(__dirname, '../../../../shared/i18n/locales');
    for (const lang of ['ko.json', 'en.json']) {
      const dict = JSON.parse(readFileSync(join(locales, lang), 'utf8')) as {
        modelSwitcher?: { auto?: string; autoHint?: string; route?: Record<string, string> };
      };
      expect(dict.modelSwitcher?.auto, lang).toBeTruthy();
      expect(dict.modelSwitcher?.autoHint, lang).toBeTruthy();
      for (const reason of REASONS) {
        expect(dict.modelSwitcher?.route?.[reason], `${lang} is missing ${reason}`).toBeTruthy();
      }
    }
  });
});

/**
 * THE WIRING, as source assertions — the route crosses three files (the stream
 * hook reads it, Chat holds it, the chip renders it) and a break anywhere in
 * that chain shows up as "the chip never changes", which is indistinguishable
 * from the router not running. Source text for the same reason
 * modelSwitcherScroll.test.ts uses it: this suite has no DOM environment.
 */
const read = (f: string) =>
  readFileSync(join(__dirname, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

describe('the route reaches the chip', () => {
  const hook = read('useChatStream.ts');
  const chat = read('Chat.tsx');
  const chip = read('ModelSwitcher.tsx');

  it('the stream hook reports it on EVERY init, absence included', () => {
    // Reporting only when present would leave the chip explaining the previous
    // turn after the user pinned a model.
    expect(hook).toMatch(/const initRoute = event\.model_route/);
    expect(hook).toMatch(/onModelRouteRef\.current\?\.\(route\)/);
    expect(hook).toMatch(/lastModelRouteRef\.current = route;/);
  });

  it('and folds in the served id when the result reports one', () => {
    expect(hook).toMatch(/\.\.\.lastModelRouteRef\.current, served: contextModel/);
    expect(hook).toMatch(/onModelRouteRef\.current\?\.\(served\)/);
  });

  it('Chat holds it, hands it to the chip, and drops it on an explicit pick', () => {
    expect(chat).toMatch(/onModelRoute: setLiveRoute,/);
    expect(chat).toMatch(/liveRoute=\{liveRoute\}/);
    expect(chat).toMatch(/if \(model !== AUTO_MODEL_VALUE\) setLiveRoute\(null\);/);
  });

  it('…and drops it on a session switch, but NOT when a session is first created', () => {
    // null → id happens on the very init that set the route; clearing there would
    // erase the first routed turn of every new session.
    expect(chat).toMatch(/if \(prev && prev !== \(liveSessionId \?\? null\)\) setLiveRoute\(null\);/);
  });

  it('the chip composes its label and tooltip through the pure helpers', () => {
    expect(chip).toMatch(/chipLabelFor\(value, liveRoute, options, modelLabel\(scope, value\)\)/);
    expect(chip).toMatch(/routeTooltip\(/);
    expect(chip).toMatch(/title=\{routeTitle \?\? t\('modelSwitcher\.title'/);
  });

  it('the TOOLTIP is gated on the same two conditions as the label', () => {
    // `chipLabelFor` needs BOTH `value === auto` and a route; a tooltip gated on
    // the route alone survives an explicit pick and explains the previous turn
    // under a chip naming the new model. The sequence is ordinary: an auto turn
    // is running, the user switches the chip to Opus, and the result's
    // `context_model` re-fires `onModelRoute` with the served id folded into the
    // route that is now stale.
    expect(chip).toMatch(/const routeTitle =\s*value === AUTO_MODEL_VALUE && liveRoute/);
    // …and the route-only form is gone.
    expect(chip).not.toMatch(/const routeTitle =\s*liveRoute\s*\n?\s*\?/);
  });

  it('the `auto` row says its label and hint in the USER’s language', () => {
    // Both keys exist in ko/en (asserted above) and are the only rows in the
    // picker whose words are naby's rather than a provider's. Unused, the Korean
    // user reads the English constant "naby picks a model per request" — which is
    // the bug this pins, and which nothing else would catch.
    expect(chip).toMatch(/t\('modelSwitcher\.auto', \{ defaultValue: o\.label \}\)/);
    expect(chip).toMatch(/t\('modelSwitcher\.autoHint', \{ defaultValue: o\.hint \}\)/);
    // Applied to the OPTION, so the chip's own "Auto" (which `chipLabelFor` reads
    // off this same list) is translated by the same line as the menu row.
    expect(chip).toMatch(/o\.value === AUTO_MODEL_VALUE/);
  });

  it('and the MENU stays a list of selections — a route is never one', () => {
    const menuAt = chip.indexOf('data-testid="model-switcher-list"');
    expect(menuAt).toBeGreaterThan(-1);
    expect(chip.slice(menuAt)).not.toContain('liveRoute');
  });
});
