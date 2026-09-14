// modelRouteLabel.ts
//
// WHAT THE MODEL CHIP SAYS WHEN NABY IS PICKING (specs/model-auto-routing.md §4.6).
//
// With `auto` selected, the chip has to answer two questions at once: what the
// user chose (naby picks) and what naby picked THIS turn. "Auto" alone answers
// only the first, and a chip that never changes is indistinguishable from a
// router that is not running — which is the failure the spec's §1 is about.
//
// PURE, AND IN ITS OWN FILE, for the same reason contextGauge and engineName are:
// the composition is the part worth pinning, and it cannot be reached through a
// component that needs a React renderer plus a live catalog fetch. Nothing here
// imports `t` — the CALLER hands in the already-translated reason line, so this
// stays a function of its arguments and the i18n lookup stays in the component.

import { AUTO_MODEL_VALUE, type ModelOption } from './modelCatalog';
import type { ModelRoute, ModelTier } from './types';

/**
 * The CATALOG ROW that stands for a tier, mirroring `pickCatalogValue` in the
 * runtime router (spec §4.3) — opus prefers the 1M row, fable is matched by
 * prefix because its value carries a version (`claude-fable-5-1[1m]`).
 *
 * Matching is exact or prefixed, never "contains", so the `default` row can
 * never be mistaken for a tier: `default` resolves to opus on this machine, and
 * labelling the chip "Auto · Default (recommended)" would explain nothing.
 */
export function tierOption(
  tier: ModelTier,
  options: readonly ModelOption[],
): ModelOption | undefined {
  const exact = (v: string) => options.find((o) => o.value === v);
  if (tier === 'opus') return exact('opus[1m]') ?? exact('opus');
  if (tier === 'fable') return options.find((o) => o.value.startsWith('claude-fable')) ?? exact('fable');
  return exact(tier);
}

/** The tier's display name: the live catalog's own label when the tier is in the
 *  list, else the tier word capitalised. Never the raw slug — `opus[1m]` on a
 *  chip reads like a bug. */
export function tierDisplayName(tier: ModelTier, options: readonly ModelOption[]): string {
  const opt = tierOption(tier, options);
  if (opt?.label) return opt.label;
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * The whole chip label.
 *
 * `Auto · Sonnet` when the pick is `auto` AND a route has arrived; plain `Auto`
 * before the first turn of the session has reported one; and for any explicit
 * pick, that option's own label — a stale route must never relabel a model the
 * user chose by hand.
 */
export function chipLabelFor(
  value: string,
  liveRoute: ModelRoute | null | undefined,
  options: readonly ModelOption[],
  fallbackLabel?: string,
): string {
  const base = options.find((o) => o.value === value)?.label ?? fallbackLabel ?? (value || 'Default');
  if (value !== AUTO_MODEL_VALUE || !liveRoute) return base;
  return `${base} · ${tierDisplayName(liveRoute.tier, options)}`;
}

/** The i18n key holding the one-line explanation for a reason code. One place,
 *  so the component and the locale files cannot drift. */
export function routeReasonKey(route: ModelRoute): string {
  return `modelSwitcher.route.${route.reason}`;
}

/**
 * The chip's tooltip: WHY this tier, and — once the result event has said so —
 * WHICH id actually answered. The served id is appended rather than shown on the
 * chip because the label's job is the tier; the exact build belongs where there
 * is room for it.
 */
export function routeTooltip(reasonText: string, served?: string): string {
  const reason = reasonText.trim();
  if (!served) return reason;
  return reason ? `${reason} · ${served}` : served;
}
