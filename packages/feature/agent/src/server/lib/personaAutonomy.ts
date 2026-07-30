// packages/feature/agent/src/server/lib/personaAutonomy.ts
//
// WHO OWNS HOW MUCH IS DELEGATED (Phase 3, P3-M9 — G1).
//
// An agent definition holds an IDENTITY: its name, its instructions, its kind.
// How much of your work you hand it is a different thing entirely — it is a
// property of the DELEGATION, and it belongs to the person doing the delegating.
// The two used to be mixed together in the agent row's `autonomy` field, and that
// was survivable while every row was editable.
//
// Locking the built-in persona (read-only, 2026-07-30) made the mix untenable.
// The seed pins `escalation:'inline'` and no `maxSteps`, and the store THROWS on
// any write to a persona row — so with autonomy living on the row, the persona
// was permanently fixed at "ask inline, one turn", and the product's own headline
// promise ("work on it until the tests pass, ping me on Telegram") was
// unreachable through the UI. Not a missing button: a missing PLACE to put the
// answer.
//
// So the answer moves to the settings table, where the user's other preferences
// live. Two keys, read by the engine for a kind='persona' turn INSTEAD of the
// row. Custom agents are untouched — their rows are editable, so there is no
// ownership problem to solve there, and a second config surface for them would
// only create two places to look.
//
// THE CLAMP RUNS ON BOTH SIDES. `resolveMaxSteps` is the runtime's one clamp
// (cap AUTONOMY_STEP_CAP, sub-2 collapses to 1 = off) and it already guards the
// read. Writing through it too means the stored value is the effective value:
// otherwise Settings would show "50" while the engine ran 20, and the number on
// screen would be a number the product does not honour.

import type { AgentEscalation } from '../../../../../../../dist/naby-runtime.mjs';
import { resolveMaxSteps } from './autonomy';

/** Where a persona turn's critical decisions go. Mirrors `Agent.autonomy.escalation`
 *  — the engine feeds both into the same channel switch. */
export const PERSONA_ESCALATION_KEY = 'persona.autonomy.escalation';

/** How many steps a persona turn may take alone. Mirrors `Agent.autonomy.maxSteps`. */
export const PERSONA_MAX_STEPS_KEY = 'persona.autonomy.maxSteps';

/** Escalation when nothing has been chosen. The M2 in-app prompt alone — the
 *  channel that needs no configuration and sends nothing off the machine. */
export const PERSONA_ESCALATION_DEFAULT: AgentEscalation = 'inline';

/** Steps when nothing has been chosen: 1 = autonomy OFF, one turn per message.
 *  Deliberately the conservative end (spec §8 leaves "raise it once the persona
 *  is a butterfly" open): a delegation setting that arrives switched on is not a
 *  delegation the user made. */
export const PERSONA_MAX_STEPS_DEFAULT = 1;

/** The narrow slice of the store these reads need — the same shape the reflection
 *  opt-in uses, so a test can hand over a plain object. */
export type PersonaAutonomySettingsStore = {
  getSetting(key: string): string | undefined;
};

export type PersonaAutonomyWriteStore = PersonaAutonomySettingsStore & {
  setSetting(key: string, value: string): void;
};

/** The user's delegation settings for the built-in persona. Always complete:
 *  every field has a default, so the engine never has to decide what an absent
 *  setting means. */
export type PersonaAutonomy = {
  escalation: AgentEscalation;
  /** Already clamped — this is the number the engine runs, not a wish. */
  maxSteps: number;
};

/** Narrow an arbitrary string to an escalation channel. Anything unrecognised
 *  (a hand-edited row, a value from a newer build) reads as the default rather
 *  than throwing: a settings row must never be able to break a turn. */
export function parseEscalation(value: string | undefined): AgentEscalation {
  return value === 'inline' || value === 'telegram' || value === 'both'
    ? value
    : PERSONA_ESCALATION_DEFAULT;
}

/** Read `maxSteps` out of its stored string, through the SAME clamp the engine
 *  applies. A blank/absent/garbage value is 1 = off. */
export function parseMaxSteps(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return PERSONA_MAX_STEPS_DEFAULT;
  const n = Number(value);
  return resolveMaxSteps(Number.isFinite(n) ? n : undefined);
}

/** THE READ the engine takes for a kind='persona' turn. Best-effort: a store
 *  hiccup yields the defaults rather than failing the turn — "one inline turn"
 *  is the safe answer to "we could not find out how much you delegate". */
export function readPersonaAutonomy(store: PersonaAutonomySettingsStore): PersonaAutonomy {
  try {
    return {
      escalation: parseEscalation(store.getSetting(PERSONA_ESCALATION_KEY)),
      maxSteps: parseMaxSteps(store.getSetting(PERSONA_MAX_STEPS_KEY)),
    };
  } catch {
    return { escalation: PERSONA_ESCALATION_DEFAULT, maxSteps: PERSONA_MAX_STEPS_DEFAULT };
  }
}

/** THE WRITE, from the persona card's delegation section. Only the supplied
 *  fields are touched (a partial save from one control never resets the other),
 *  and `maxSteps` is clamped BEFORE it is stored — see the header. Returns the
 *  settings as they now stand, so the caller renders what was actually kept
 *  rather than what it sent. */
export function writePersonaAutonomy(
  store: PersonaAutonomyWriteStore,
  input: { escalation?: string | undefined; maxSteps?: number | undefined },
): PersonaAutonomy {
  if (input.escalation !== undefined) {
    store.setSetting(PERSONA_ESCALATION_KEY, parseEscalation(input.escalation));
  }
  if (input.maxSteps !== undefined) {
    store.setSetting(
      PERSONA_MAX_STEPS_KEY,
      String(resolveMaxSteps(Number.isFinite(input.maxSteps) ? input.maxSteps : undefined)),
    );
  }
  return readPersonaAutonomy(store);
}
