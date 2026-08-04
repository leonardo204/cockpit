// packages/feature/agent/src/server/lib/harnessHome.ts
//
// TURN-TIME INSTALL STEERING — "install into MY harness home, not the vendor's"
// (skill-hub-builtin §2.5).
//
// THE PROBLEM THIS SOLVES. A skill hub's install instructions are written for
// Claude Code, so they say `~/.claude/skills/<name>/SKILL.md`. A model that
// follows them literally installs the user's new capability into ANOTHER
// PRODUCT'S directory — which is the exact inversion of what naby is for ("keep
// the memory and the harness outside the vendor, as my own asset"). It is also
// asymmetric across engines: a file under `~/.claude` is loaded natively by the
// Agent SDK on `dev-claude` AND injected by naby's own store on every other
// engine, so the same skill reaches one engine twice and the other once.
//
// A file under `~/.naby` is read by no SDK. So every engine receives it by the
// single path naby owns — the store, after the import gate. That is the whole
// point of the naby harness home, and this module is the two or three sentences
// that get the model to aim there.
//
// WHY THE INSTRUCTION IS GATED ON A CONFIGURED skill-hub ENTRY. Same rule the
// learning and check-in instructions follow: words only ship alongside the
// capability they are about. Without a hub the model has nothing installing
// anything this turn, and a paragraph about install paths is pure system-prompt
// tax on every unrelated turn.
//
// WHY THE ENTRY AND NOT THE LOADED TOOLSET. The alternative test is "did this
// turn's MCP load produce `skill-hub__*` tools". Both are defensible; the entry
// is chosen because it is:
//   - STABLE — a hub that is momentarily down (expired token, network) would
//     silently flip the instruction off, and the user would get a differently
//     behaved model on a flaky network rather than a clear failure;
//   - CHEAP — one already-loaded registry read, no dependency on where in the
//     turn the MCP load finished;
//   - HONEST ABOUT ITS SUBJECT — the instruction is about where INSTALLS GO, and
//     a user who has configured a hub is a user whose installs need aiming,
//     whether or not this particular turn's connection succeeded.
// A `proposed` entry (agent-suggested, not yet approved) does NOT count: it is
// not loaded, so nothing can drive an install through it.

import * as os from 'node:os';
import * as path from 'node:path';
import { isMcpEntryActive } from '../../../../../../../dist/naby-runtime.mjs';
import type { Store } from '../../../../../../../dist/naby-runtime.mjs';
import { SKILL_HUB_SERVER_NAME } from './systemMcp';

/** The naby harness home's directory name, under `~` or a project root. Declared
 *  HERE, in the leaf module, and imported by the scanner — not the other way
 *  round: this file is what the engine loads per turn, and pointing it at the
 *  importer would drag the whole parse path (js-yaml and all) into every graph
 *  that only wanted to know a directory name. */
export const NABY_HARNESS_DIR = '.naby';

/** The vendor directory an EXPLICIT IMPORT copies out of, once — not a place naby
 *  reads on a schedule (harness-standalone §2.2). The ecosystem's installers
 *  still write there, so abandoning it would strand what is already on the user's
 *  disk; but a standing read would make another product's directory a live second
 *  source of truth, which is the thing naby is not. Exactly one function resolves
 *  a path from this constant (`resolveVendorBases`) and exactly one caller uses
 *  it. */
export const CLAUDE_HARNESS_DIR = '.claude';

/** The three content directories a harness home holds. Same names Claude Code
 *  uses — the LAYOUT is the ecosystem's, only the base directory is ours, which
 *  is what makes "substitute the base and follow the rest" a safe instruction. */
export const HARNESS_CONTENT_DIRS = ['skills', 'commands', 'agents'] as const;

/** The user-scope harness home. `homeDir` is a test seam, as in the importer. */
export function userHarnessHome(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), NABY_HARNESS_DIR);
}

/** The project-scope harness home for an open project, if there is one. */
export function projectHarnessHome(cwd?: string): string | undefined {
  return cwd ? path.join(cwd, NABY_HARNESS_DIR) : undefined;
}

/**
 * Whether install steering is worth its words this turn: the owner has a
 * skill-hub entry that is actually active (approved, not merely proposed).
 */
export function canSteerInstalls(store: Pick<Store, 'listMcpEntries'>): boolean {
  try {
    return store
      .listMcpEntries()
      .some((entry) => entry.name === SKILL_HUB_SERVER_NAME && isMcpEntryActive(entry));
  } catch {
    // A registry read that throws is not a reason to fail a turn; it only means
    // the extra paragraph is left out.
    return false;
  }
}

/**
 * The system-prompt block that redirects installs. Short on purpose — it shares
 * the turn's system field with the persona, the memory block, the skills, the
 * learning and check-in instructions and (when autonomous) the step protocol.
 *
 * It says three things, in this order, because that is the order the model needs
 * them: where the home IS, that a vendor path in someone else's instructions is
 * to be SUBSTITUTED rather than obeyed, and what enable state the result arrives
 * in — which depends on the auto-enable kill switch (gate invariant 7), so the
 * caller passes the CURRENT setting and the model never guesses. Before the
 * switch existed this block hardcoded "arrives DISABLED", and the model kept
 * telling users to go flip a toggle that was already on.
 */
export function harnessHomeInstruction(
  cwd?: string,
  homeDir?: string,
  autoEnable: boolean = true,
): string {
  const user = userHarnessHome(homeDir);
  const project = projectHarnessHome(cwd);
  const where = project
    ? `\`${user}/{skills,commands,agents}\` for anywhere, or \`${project}/{skills,commands,agents}\` for this project only`
    : `\`${user}/{skills,commands,agents}\``;
  const arrival = autoEnable
    ? `A skill you install here at the user's request arrives ENABLED and works after the next harness scan; items copied in from another product's folder still arrive disabled. Say what you installed and that it is on —`
    : `Anything installed this way arrives DISABLED and the user turns it on in Settings — say you installed it, never that it is now in effect;`;
  return [
    `HARNESS HOME: naby keeps its skills, commands and subagents in its own home — ${where}.`,
    `When you install one, write it there: install instructions from a skill hub or a README will name`,
    `\`~/.claude\` because they are written for another product, so substitute the base directory and`,
    `keep everything below it (\`skills/<name>/SKILL.md\`, \`commands/<name>.md\`, \`agents/<name>.md\`) exactly as given.`,
    arrival,
    `the Settings harness tab shows the final state.`,
  ].join('\n');
}
