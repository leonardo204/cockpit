// packages/feature/agent/src/server/lib/learning.ts
//
// TURN-TIME LEARNING INSTRUCTION (Phase 3, P3-M4b).
//
// The runtime owns the learning TOOL (`naby_remember`, tools.ts) and the write
// gate; this owns the one thing the shell must decide per turn: whether to TELL
// the agent to learn, and in what words.
//
// WHY THE INSTRUCTION IS NEEDED AT ALL. A tool the model is never told to use is
// a tool it uses erratically — and a persona agent that only remembers when it
// happens to feel like it produces exactly the "measured but never learned"
// failure the personalization strategy warns about (§요약). The instruction is
// what closes capture → review → injection into a loop.
//
// WHY IT IS GATED ON `canLearn`. An agent restricted by `toolRefs` may not be
// allowed to call `naby_remember` at all — the P3-M2 allowlist denies it at the
// outermost gate. Injecting the instruction anyway would have the agent
// repeatedly try a call that can only fail, which is the same "no silent
// half-run" the skill injection avoids by checking `availableTools` first. So the
// words go in only when the call can actually land.

import { normalizeToolName, REMEMBER_TOOL_NAME } from '../../../../../../../dist/naby-runtime.mjs';
import type { Agent, MemoryScope } from '../../../../../../../dist/naby-runtime.mjs';

/** Human-readable reach of each scope, for the instruction text. */
const SCOPE_REACH: Record<MemoryScope, string> = {
  session: 'this conversation only',
  project: 'this working directory only',
  user: 'everywhere, for this user',
  org: 'the whole organization',
};

/**
 * Whether `naby_remember` can actually be called on this turn: there has to be a
 * routed agent (the tool is only built for one) and, if that agent is restricted
 * to an allowlist, the tool has to be on it.
 */
export function canLearn(agent: Agent | undefined): boolean {
  if (!agent) return false;
  if (!agent.toolRefs) return true; // unrestricted (the built-in persona's default)
  return agent.toolRefs.map(normalizeToolName).includes(REMEMBER_TOOL_NAME);
}

/**
 * The system-prompt block that turns the tool into a habit. Kept short on
 * purpose — it shares the turn's system field with the persona, the memory block,
 * the skills and (when autonomous) the step protocol.
 *
 * It states the three things the model gets wrong without being told: that a
 * capture is a proposal rather than a live fact (so it must not claim to the user
 * that it "will now always" do something), that durability is the bar (not "this
 * message"), and that secrets are never memories.
 */
export function learningInstruction(agent: Agent): string {
  const scope = agent.memoryScope;
  return [
    `LEARNING: you keep a memory of this user. When this conversation teaches you something that`,
    `would still be true next week — how they want work done, a standing rule, their team's terms,`,
    `the state of an ongoing project — record it with \`${REMEMBER_TOOL_NAME}\` as you go.`,
    '',
    `- Your default scope is "${scope}" (${SCOPE_REACH[scope]}). Use "user" for a fact that holds`,
    `  anywhere, "project" for one tied to this directory.`,
    `- Each entry is saved as a PROPOSAL and changes nothing until the user confirms it in Settings.`,
    `  So never tell them a preference is "now applied" — say you noted it.`,
    `- Skip: transient task state, anything true only for this message, facts you already recorded,`,
    `  and secrets (tokens, keys, passwords) — record the preference, never the credential.`,
  ].join('\n');
}
