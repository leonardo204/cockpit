/**
 * Short, human-facing name of whatever engine is answering the current turn —
 * the word shown in the "… is thinking" loading bubble.
 *
 * WHY A PURE HELPER. The "thinking" label used to be a hardcoded "Claude", which
 * lied whenever an Azure / Gemini / ChatGPT provider actually answered. The right
 * name depends on the engine/provider the runtime resolved for THIS turn, which
 * is data the chat UI already has (the `/api/naby` engine state + the turn's
 * live-resolved model). Keeping the derivation here — a pure function of that
 * data — makes it unit-testable and keeps the three call sites (EngineSwitcher,
 * Chat, MessageList) agreeing by construction.
 *
 * PRECEDENCE:
 *   1. dev engine (Claude Agent SDK) always answers as Claude.
 *   2. a metered provider maps by its KIND (== the `/api/naby` provider id).
 *   3. otherwise sniff the resolved model string (`liveModel`).
 *   4. nothing identifies it → the generic "AI".
 */

export interface EngineNameInput {
  /** `/api/naby` `engine.id`: 'dev-claude' | 'ai-sdk' (or absent before a read). */
  engineId?: string | null;
  /** The selected provider's KIND. In `/api/naby` a provider's `id` IS its kind
   *  (profiles are stored `id: kind`), e.g. 'anthropic' | 'azure-openai'. */
  providerKind?: string | null;
  /** The engine's RESOLVED model for this turn, captured from system/init, e.g.
   *  'claude-3-5-sonnet…' | 'gpt-4o' | 'gemini-2.0…'. Used as a fallback when the
   *  engine/provider identity is not (yet) known. */
  liveModel?: string | null;
}

/** The generic label used when no engine/provider identity can be determined. */
export const GENERIC_ENGINE_NAME = 'AI';

/** The dev engine (Claude Agent SDK) — always Claude. */
const DEV_ENGINE_ID = 'dev-claude';

/** Provider KIND → short brand name. Kinds come from the runtime's
 *  `describeProviders()` and are the same strings `/api/naby` reports as a
 *  provider `id`. */
const PROVIDER_KIND_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  bedrock: 'Claude',
  'azure-openai': 'GPT',
  openai: 'GPT',
  google: 'Gemini',
  'openai-chatgpt-oauth': 'ChatGPT',
};

/**
 * Sniff a brand name out of a resolved model string. Order matters: 'chatgpt'
 * contains 'gpt', so it must be tested first to avoid mislabeling a ChatGPT
 * subscription model as plain GPT.
 */
function nameFromModel(model?: string | null): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('chatgpt')) return 'ChatGPT';
  if (m.includes('claude')) return 'Claude';
  if (m.includes('gemini')) return 'Gemini';
  if (m.includes('gpt')) return 'GPT';
  return null;
}

/** The provider id of the DEV-ONLY ChatGPT subscription provider. In /api/naby a
 *  provider's id IS its kind, so this is both its id and its kind. */
export const CHATGPT_OAUTH_PROVIDER_ID = 'openai-chatgpt-oauth';

/** Which account sign-in chip the chat bottom bar should show for the resolved
 *  engine. 'none' for a plain API-key provider — a key is not an account login. */
export type AccountChip = 'claude' | 'chatgpt' | 'none';

/**
 * Decide the bottom-bar account chip from the RESOLVED engine identity. The bar
 * shows exactly ONE sign-in, matching the engine that will answer:
 *   * ai-sdk + the ChatGPT subscription provider → the ChatGPT chip.
 *   * ai-sdk + any other (API-key) provider       → no chip.
 *   * dev-claude, or unknown/loading (null)        → the Claude chip, which
 *     self-hides when the dev engine is not part of this build.
 * Pure so the switch is unit-testable and the three call sites agree.
 */
export function accountChipForEngine(input: {
  engineId: string | null;
  selectedProvider: string | null;
}): AccountChip {
  if (input.engineId === 'ai-sdk') {
    return input.selectedProvider === CHATGPT_OAUTH_PROVIDER_ID ? 'chatgpt' : 'none';
  }
  return 'claude';
}

/**
 * Derive the short engine name for the "thinking" label. Never throws; always
 * returns a display string (falls back to {@link GENERIC_ENGINE_NAME}).
 */
export function deriveEngineName(input: EngineNameInput): string {
  if (input.engineId === DEV_ENGINE_ID) return 'Claude';

  if (input.providerKind) {
    const byKind = PROVIDER_KIND_NAMES[input.providerKind];
    if (byKind) return byKind;
  }

  const byModel = nameFromModel(input.liveModel);
  if (byModel) return byModel;

  return GENERIC_ENGINE_NAME;
}
