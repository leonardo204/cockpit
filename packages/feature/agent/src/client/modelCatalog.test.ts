import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTO_MODEL_VALUE,
  CHATGPT_OAUTH_PROVIDER_ID,
  CLAUDE_AUTO_MODEL,
  CLAUDE_MODELS,
  CLAUDE_MODELS_FOR_AGENTS,
  CLAUDE_MODEL_SCOPE,
  GOOGLE_MODEL_SCOPE,
  agentModelOptions,
  claudeOptionsFrom,
  defaultModelForScope,
  googleOptionsFrom,
  modelLabel,
  modelScopeFor,
  modelsForScope,
  scopeHasLiveCatalog,
  type LiveModel,
} from './modelCatalog';

/**
 * The Claude model list is now LIVE — asked of the local sign-in rather than
 * hardcoded, so a newly released model needs no rebuild. These pin the two things
 * that make that safe: an empty or failed answer must not empty the picker, and the
 * live rows must not be reshaped into something less accurate than the SDK said.
 */

// Shape taken verbatim from a real probe of a signed-in machine.
const LIVE: LiveModel[] = [
  {
    value: 'default',
    displayName: 'Default (recommended)',
    description: 'Opus 4.8 with 1M context · Best for everyday, complex work',
    resolvedModel: 'claude-opus-4-8[1m]',
  },
  { value: 'opus[1m]', displayName: 'Opus', description: 'Opus 4.8 with 1M context', resolvedModel: 'claude-opus-4-8[1m]' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', resolvedModel: 'claude-sonnet-5' },
];

describe('claudeOptionsFrom', () => {
  it('uses the live list when there is one, values and labels verbatim', () => {
    const opts = claudeOptionsFrom(LIVE);
    // `auto` leads (it is ours, not the SDK's — see below); the SDK's own rows
    // follow in its order.
    expect(opts.map((o) => o.value)).toEqual(['auto', 'default', 'opus[1m]', 'sonnet']);
    expect(opts[1]!.label).toBe('Default (recommended)');
    // The value is what gets SENT as the turn's model, so it must survive exactly —
    // `opus[1m]` is not `opus`.
    expect(opts[2]!.value).toBe('opus[1m]');
    expect(opts[3]!.hint).toContain('Efficient for routine tasks');
  });

  it('does NOT add an empty "default" row on top of the SDK\'s own', () => {
    // Two rows both meaning "let Claude pick" is what makes a picker look broken.
    expect(claudeOptionsFrom(LIVE).filter((o) => o.value === '')).toHaveLength(0);
  });

  it('falls back to the curated list when the probe gave nothing', () => {
    // Not signed in, SDK missing, CLI timed out — none of them may empty the picker.
    expect(claudeOptionsFrom(null)).toEqual(CLAUDE_MODELS);
    expect(claudeOptionsFrom(undefined)).toEqual(CLAUDE_MODELS);
    expect(claudeOptionsFrom([])).toEqual(CLAUDE_MODELS);
  });

  it('the fallback offers ALIASES, never pinned version ids', () => {
    // An alias resolves to whatever the plan grants, so the fallback cannot
    // advertise a model the user does not have — and cannot claim a version number
    // that has since moved on.
    for (const o of CLAUDE_MODELS) {
      expect(o.value).not.toMatch(/\d/);
      expect(o.label).not.toMatch(/\d/);
    }
  });

  it('survives a row with no description', () => {
    const opts = claudeOptionsFrom([{ value: 'x', displayName: 'X' }]);
    expect(opts).toEqual([CLAUDE_AUTO_MODEL, { value: 'x', label: 'X' }]);
  });
});

/**
 * `auto` — THE ROW THAT IS NOT A MODEL (specs/model-auto-routing.md §4.1).
 *
 * It is a per-turn instruction the shell engine intercepts: naby runs a router
 * and sends a real catalog value in its place. Two things make that safe, and
 * both are pinned here. It must appear in BOTH lists — the live list REPLACES
 * the curated one, so a row that lived only in the constant would vanish on
 * every signed-in machine. And it must not redefine `''`: "let the SDK decide"
 * and "let naby decide" are different answers and the user can still ask for
 * either.
 */
describe('the auto row', () => {
  it('leads the curated fallback', () => {
    expect(CLAUDE_MODELS[0]).toBe(CLAUDE_AUTO_MODEL);
    expect(CLAUDE_MODELS[0]!.value).toBe(AUTO_MODEL_VALUE);
    expect(CLAUDE_MODELS[0]!.label).toBe('Auto');
  });

  it('is PREPENDED to a live list, which would otherwise replace it away', () => {
    const opts = claudeOptionsFrom(LIVE);
    expect(opts[0]).toBe(CLAUDE_AUTO_MODEL);
    expect(opts.filter((o) => o.value === AUTO_MODEL_VALUE)).toHaveLength(1);
  });

  it('labels as "Auto" wherever a raw value has to be rendered', () => {
    expect(modelLabel(CLAUDE_MODEL_SCOPE, AUTO_MODEL_VALUE)).toBe('Auto');
  });

  it('does NOT become the default — an untouched install still means SDK default', () => {
    // Principle 6: `''` keeps its meaning. Turning auto on for everyone would be
    // a different decision from offering it, and it is not this one.
    expect(defaultModelForScope(CLAUDE_MODEL_SCOPE)).toBe('');
    expect(defaultModelForScope(null)).toBe('');
  });

  it('is offered by the CHAT BAR ONLY, never by a picker whose choice is stored', () => {
    // An agent saved with `model: 'auto'` would hand that literal to the SDK on
    // every turn routed to it — the server validates no model string (spec §3).
    // The routing happens per turn, so the value cannot be persisted anywhere.
    expect(CLAUDE_MODELS_FOR_AGENTS.some((o) => o.value === AUTO_MODEL_VALUE)).toBe(false);
    expect(CLAUDE_MODELS_FOR_AGENTS.map((o) => o.value)).toEqual(['', 'fable', 'opus', 'sonnet', 'haiku']);
    // …and the filter works on a LIVE list too, which is what an agent picker
    // would actually be showing.
    expect(agentModelOptions(claudeOptionsFrom(LIVE)).map((o) => o.value)).toEqual([
      'default',
      'opus[1m]',
      'sonnet',
    ]);
  });

  it('and the lists that contain it have exactly one consumer: the chat-bar chip', () => {
    // The guard above only helps if agent-facing code reaches for the filtered
    // list. This is what makes a NEW picker notice: importing the raw option
    // lists anywhere but the chip fails here, and the failure names the fix.
    const dir = __dirname;
    const offenders = readdirSync(dir)
      .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'))
      .filter((f) => f !== 'modelCatalog.ts' && f !== 'ModelSwitcher.tsx')
      .filter((f) => {
        const src = readFileSync(join(dir, f), 'utf8');
        const imports = /import\s*\{([^}]*)\}\s*from\s*'\.\/modelCatalog'/.exec(src)?.[1] ?? '';
        return /\b(CLAUDE_MODELS|claudeOptionsFrom|modelsForScope)\b/.test(imports);
      });
    expect(
      offenders,
      'these list the raw catalog (auto included) — use CLAUDE_MODELS_FOR_AGENTS / agentModelOptions',
    ).toEqual([]);
  });
});

/**
 * GEMINI IS PICKABLE IN A SESSION, and the other metered providers still are not.
 *
 * The rule is not "metered vs subscription" — it is "does one key address one
 * model". A Google key opens the whole catalog, so the model is a per-turn
 * choice; an Azure key addresses one deployment and an Anthropic/OpenAI profile
 * names the one model the user configured, so for those the model stays a
 * profile setting and the switcher must keep rendering nothing.
 */
describe('modelScopeFor — which engines expose a session model pick', () => {
  it('gives Google a scope', () => {
    expect(modelScopeFor('ai-sdk', 'google')).toBe(GOOGLE_MODEL_SCOPE);
  });

  it('still gives the other metered providers none', () => {
    expect(modelScopeFor('ai-sdk', 'azure-openai')).toBeNull();
    expect(modelScopeFor('ai-sdk', 'anthropic')).toBeNull();
    expect(modelScopeFor('ai-sdk', 'openai')).toBeNull();
    expect(modelScopeFor('ai-sdk', null)).toBeNull();
  });

  it('leaves the two subscription engines exactly as they were', () => {
    expect(modelScopeFor('ai-sdk', CHATGPT_OAUTH_PROVIDER_ID)).toBe(CHATGPT_OAUTH_PROVIDER_ID);
    expect(modelScopeFor('dev-claude', null)).toBe(CLAUDE_MODEL_SCOPE);
    expect(modelScopeFor(null, null)).toBe(CLAUDE_MODEL_SCOPE);
  });

  it('marks the fetched catalogs, and only those', () => {
    expect(scopeHasLiveCatalog(GOOGLE_MODEL_SCOPE)).toBe(true);
    expect(scopeHasLiveCatalog(CLAUDE_MODEL_SCOPE)).toBe(true);
    expect(scopeHasLiveCatalog(CHATGPT_OAUTH_PROVIDER_ID)).toBe(false);
    expect(scopeHasLiveCatalog(null)).toBe(false);
  });

  it('defaults Google to "no override", so an unpicked session uses the profile model', () => {
    // The profile's own model must keep answering until the user picks something
    // — adding a picker may not change what happens when nobody touches it.
    expect(defaultModelForScope(GOOGLE_MODEL_SCOPE)).toBe('');
  });
});

describe('googleOptionsFrom', () => {
  it('offers the live ids plus a way back to the profile model', () => {
    const opts = googleOptionsFrom(['gemini-2.5-pro', 'gemini-2.5-flash']);
    expect(opts.map((o) => o.value)).toEqual(['', 'gemini-2.5-pro', 'gemini-2.5-flash']);
    // The id IS the label: renaming it in a picker would just be a second name
    // for the string the user has to recognise in Settings.
    expect(opts[1]!.label).toBe('gemini-2.5-pro');
  });

  it('has NO curated fallback — an empty answer renders no picker', () => {
    // A hardcoded Gemini list is exactly the stale catalog the live lookup exists
    // to replace, and it would advertise models a key may not have.
    expect(googleOptionsFrom(null)).toEqual([]);
    expect(googleOptionsFrom(undefined)).toEqual([]);
    expect(googleOptionsFrom([])).toEqual([]);
    expect(modelsForScope(GOOGLE_MODEL_SCOPE)).toEqual([]);
  });
});
