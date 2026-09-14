// modelTierLabel.ts
//
// A RESOLVED MODEL ID, SHORT ENOUGH TO SIT IN A ROW (specs/subagent-delegation.md §4.3).
//
// A subagent block reports the model that actually served the run, and what the
// backend hands over is the full id — `claude-haiku-4-5-20251001`. Printed raw it
// is longer than the rest of the line put together and buries the one bit the
// reader wants, which is the TIER: was the cheap agent actually cheap?
//
// So a known Claude id reads as its tier word and anything else reads as itself.
// The fallback is deliberate: a Bedrock/Vertex id, an unreleased build or a
// gateway alias must still be SHOWN, because "an id I do not recognise answered"
// is exactly the drift this whole feature exists to surface. Guessing a tier for
// it — or hiding it — would put the display back to saying nothing.
//
// PURE AND UNTRANSLATED, like `modelRouteLabel.ts`: tier words are model names,
// not prose, and they are the same in every locale.

import type { ModelTier } from './types';

/** The tier words the router chooses between, as they are shown. The TYPE is
 *  the client's one `ModelTier` (`types.ts`), the same one `modelRouteLabel.ts`
 *  uses — a second spelling of the tiers is how two parts of this screen end up
 *  disagreeing about what `fable` is. */
const TIERS: readonly ModelTier[] = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * The tier a resolved model id belongs to, or `undefined` when it names nothing
 * we route between.
 *
 * MIRRORS THE RULES of the runtime's `tierOfModelId` (`src/runtime/model-router.ts`
 * §4.4) rule for rule: case-folded, a trailing bracketed suffix dropped so
 * `opus[1m]` reads as the alias it is, bare aliases accepted, then `claude-fable`
 * matched BEFORE the generic families. Restated rather than imported because the
 * client cannot reach into the runtime bundle — and restated IN FULL rather than
 * approximated, because a divergence would label a block with a different tier
 * than the activity log gives the same run.
 */
export function modelTierOf(id: string | undefined): ModelTier | undefined {
  const raw = (id ?? '').trim().toLowerCase();
  if (raw === '') return undefined;
  const bare = raw.replace(/\[[^\]]*\]$/, '');
  if ((TIERS as readonly string[]).includes(bare)) return bare as ModelTier;
  if (bare.includes('claude-fable')) return 'fable';
  if (bare.includes('claude-opus')) return 'opus';
  if (bare.includes('claude-sonnet')) return 'sonnet';
  if (bare.includes('claude-haiku')) return 'haiku';
  return undefined;
}

/**
 * What a subagent block prints for the model that served it: the tier word for a
 * Claude id we know, the id itself for anything else.
 *
 * Never empty for a non-empty input, and never invented for an empty one.
 */
export function modelTierLabel(id: string | undefined): string {
  const raw = (id ?? '').trim();
  if (raw === '') return '';
  return modelTierOf(raw) ?? raw;
}
