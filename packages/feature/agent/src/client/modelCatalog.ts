// modelCatalog.ts
//
// The candidate models the chat-bar ModelSwitcher offers, per engine/provider.
// There is NO per-provider model list in the runtime (each provider exposes a
// single default `model` string), so the switcher supplies its own curated
// catalog and sends the picked slug as the turn's `model` field — which the
// server already honors end-to-end (DispatchParams.model → requestedModel).
//
// Researched 2026-07-24 from FIRST sources:
//   * ChatGPT/codex — openai/codex live `codex-rs/models-manager/models.json`
//     (the ChatGPT-account subscription backend catalog). `gpt-5-codex` (old) is
//     REJECTED by that backend; the family moved to gpt-5.6. `codex-auto-review`
//     is internal and excluded.
//   * Claude — installed `@anthropic-ai/claude-agent-sdk`: it accepts a model
//     ALIAS (`opus|sonnet|haiku|fable`) or a full id. Aliases are plan-agnostic
//     (they resolve to whatever the local sign-in grants), so we offer aliases
//     rather than pinning an id the plan might lack. '' = inherit the SDK default.

import { CHATGPT_OAUTH_PROVIDER_ID } from './engineName';

/** A selectable model. `value` is the exact string sent as the turn's `model`
 *  (empty string = send no model → the engine's own default). */
export interface ModelOption {
  value: string;
  label: string;
  /** Short one-line capability note (English proper-noun descriptors). */
  hint?: string;
}

/** The scope key a switcher persists/reads under. Mirrors accountChipForEngine:
 *  the ChatGPT provider id for the subscription engine, a fixed key for Claude. */
export const CLAUDE_MODEL_SCOPE = 'dev-claude';
export { CHATGPT_OAUTH_PROVIDER_ID };

/**
 * Claude Agent SDK (local subscription sign-in) — the FALLBACK only.
 *
 * The live list comes from the SDK (`models.list` → `probeClaudeModels`), which
 * reports what this sign-in is actually entitled to. That is strictly better than
 * anything maintained here, and it is why a new model no longer needs a rebuild.
 * This constant is what the picker shows before the first probe answers, or when
 * the user is not signed in.
 *
 * Left with ALIASES rather than pinned ids on purpose: an alias resolves to
 * whatever the plan grants, so it cannot advertise a model the user does not have.
 */
export const CLAUDE_MODELS: ModelOption[] = [
  { value: '', label: 'Default', hint: 'let Claude pick' },
  { value: 'opus', label: 'Opus', hint: 'most capable' },
  { value: 'sonnet', label: 'Sonnet', hint: 'balanced' },
  { value: 'haiku', label: 'Haiku', hint: 'fast & light' },
  { value: 'fable', label: 'Fable', hint: 'creative' },
];

/** One row of the live catalog, as `models.list` returns it. */
export type LiveModel = {
  value: string;
  displayName: string;
  description?: string;
  resolvedModel?: string;
};

/**
 * Turn the SDK's answer into picker options.
 *
 * The SDK's own list already contains a `default` row, so no `''` entry is added:
 * two rows both meaning "let Claude pick" is the kind of duplication that makes a
 * picker look broken. When the list is empty (never probed, or not signed in) the
 * curated fallback is returned unchanged.
 */
export function claudeOptionsFrom(live: readonly LiveModel[] | null | undefined): ModelOption[] {
  if (!live || live.length === 0) return CLAUDE_MODELS;
  return live.map((m) => ({
    value: m.value,
    label: m.displayName || m.value,
    // The SDK descriptions read like "Opus 4.8 with 1M context · Best for …" —
    // already the one-line hint this needs, so it is passed through rather than
    // re-worded into something less accurate.
    ...(m.description ? { hint: m.description } : {}),
  }));
}

/** ChatGPT subscription (codex backend). Order = strongest → lightest. */
export const CHATGPT_MODELS: ModelOption[] = [
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', hint: 'frontier agentic coding' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', hint: 'balanced everyday' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', hint: 'fast & affordable' },
  { value: 'gpt-5.5', label: 'GPT-5.5', hint: 'complex coding & research' },
  { value: 'gpt-5.4', label: 'GPT-5.4', hint: 'strong everyday coding' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', hint: 'small, fast, cheap' },
  { value: 'gpt-5.2', label: 'GPT-5.2', hint: 'professional / long agents' },
];

/**
 * The switcher scope for an active engine selection, or null when the engine
 * has no user-facing model choice (a metered API-key provider — its model is a
 * profile setting, not a per-turn pick). Mirrors `accountChipForEngine`.
 */
export function modelScopeFor(
  engineId: string | null,
  selectedProvider: string | null,
): string | null {
  if (engineId === 'ai-sdk') {
    return selectedProvider === CHATGPT_OAUTH_PROVIDER_ID ? CHATGPT_OAUTH_PROVIDER_ID : null;
  }
  // dev-claude (or a not-yet-resolved claude engine) → the Claude catalog.
  return CLAUDE_MODEL_SCOPE;
}

/** The catalog for a scope. Empty for an unknown scope. */
export function modelsForScope(scope: string | null): ModelOption[] {
  if (scope === CHATGPT_OAUTH_PROVIDER_ID) return CHATGPT_MODELS;
  if (scope === CLAUDE_MODEL_SCOPE) return CLAUDE_MODELS;
  return [];
}

/** The scope's default `model` value when the user has picked none. Matches the
 *  server-side defaults (ChatGPT → gpt-5.6-sol; Claude → SDK default = ''). */
export function defaultModelForScope(scope: string | null): string {
  if (scope === CHATGPT_OAUTH_PROVIDER_ID) return 'gpt-5.6-sol';
  return '';
}

/** The display label for a raw model value within a scope (falls back to the
 *  raw value so an unknown/overridden slug still renders sensibly). */
export function modelLabel(scope: string | null, value: string): string {
  const opt = modelsForScope(scope).find((m) => m.value === value);
  if (opt) return opt.label;
  return value || 'Default';
}
