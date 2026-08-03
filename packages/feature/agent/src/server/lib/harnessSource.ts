// packages/feature/agent/src/server/lib/harnessSource.ts
//
// DELETING A HARNESS ITEM — WHICH TIER, AND WHAT MAY BE UNLINKED.
//
// THE BUG THIS EXISTS FOR. Since scan-on-list (v1.8.1) the on-disk tree is a
// SECOND source of truth: every harness list re-imports the naby harness home.
// So deleting a row deleted nothing durable — the file was still there, and the
// very next list re-imported it as a fresh disabled row. The user deleted A, B, C
// and watched them reappear at the bottom of the list after D…Z. A delete that
// undoes itself is not a delete.
//
// THE RULE, AND WHY IT IS TWO-TIERED. It follows ownership, which is the whole
// premise of the naby harness home (skill-hub-builtin §2.5):
//
//   TIER 1 — THE FILE IS OURS. `provenance.origin` sits under a naby harness home
//     (`~/.naby/...` or `<cwd>/.naby/...`). naby put it there, no other product
//     reads it, and the user asking to delete it means the artifact, not a row in
//     a table. Delete the SOURCE and then the row. A skill in the canonical
//     directory layout (`skills/<name>/SKILL.md`) takes its whole directory with
//     it, because what remains otherwise is a folder of orphaned reference files
//     that the scanner will silently ignore forever.
//
//   TIER 2 — THE FILE IS NOT OURS, OR THERE IS NONE. Either there is no origin
//     at all (a user-authored command, a set import), or the origin sits outside
//     every naby home. Since harness-standalone §2.1 an import COPIES into the
//     naby home, so a fresh row is always tier 1 — tier 2's outside-the-home case
//     is now mostly rows imported BEFORE that change, whose origin still points
//     into `~/.claude`. naby must not reach into another product's directory and
//     unlink a file the user may still be using in that product. So the row is
//     TOMBSTONED (status:'removed', store.ts): it stays in the table, which is
//     exactly what makes the scan treat the artifact as already-seen instead of
//     new, and it stops showing in the list. The user can restore it later.
//
// CONTAINMENT IS CHECKED TWICE, AND THE SECOND CHECK IS THE REAL ONE.
// `planHarnessDelete` decides the tier from the path as WRITTEN (pure, testable,
// no disk). `deleteHarnessSource` then re-derives containment from REALPATHS
// before it unlinks anything, so a symlink at any level — the origin itself, the
// skill directory, or a `.naby` that is a link to somewhere else — cannot make
// `~/.naby/skills/x/SKILL.md` name a file outside the home. A refusal is never
// fatal: the caller falls back to a tombstone, which is the conservative answer.
//
// fs AND homeDir ARE INJECTED, as everywhere else in this server package, so the
// whole decision + deletion path is unit-testable against a temp dir (or a fake)
// without touching a real `~/.naby`.

import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NABY_HARNESS_DIR } from './harnessHome';
import type { HarnessItem, HarnessScope } from '../../../../../../../dist/naby-runtime.mjs';

// ---------------------------------------------------------------------------
// Injectable fs seam — the four calls a containment-checked delete needs.
// ---------------------------------------------------------------------------

export interface SourceFs {
  existsSync(p: string): boolean;
  /** Resolves every symlink in the path. THROWS when the path does not exist —
   *  which the caller reads as "nothing to delete", not as an error. */
  realpathSync(p: string): string;
  statSync(p: string): { isDirectory(): boolean; isFile(): boolean };
  rmSync(p: string, opts: { recursive: boolean; force: boolean }): void;
}

// ---------------------------------------------------------------------------
// Tier decision (pure path logic).
// ---------------------------------------------------------------------------

/**
 * The naby harness homes a scope's items can legitimately live under.
 *
 * `user` is `<home>/.naby`; `project` is `<cwd>/.naby`, and for project scope the
 * scopeKey IS the cwd (that is how the whole route addresses it). `org` has no
 * on-disk home at all — an org item arrives by set import — so it yields none,
 * which makes every org row tier 2 by construction.
 *
 * Only NABY homes are listed. `.claude` is deliberately absent: it is the tier-2
 * boundary, and the way to be sure a vendor file is never unlinked is for no code
 * path to ever be able to name one. (The importer's `resolveVendorBases` names
 * one, for reading and copying — never for deleting, and never from here.)
 */
export function nabyHarnessBases(args: {
  scope: HarnessScope;
  scopeKey: string;
  homeDir?: string;
}): string[] {
  if (args.scope === 'user') {
    return [path.join(args.homeDir ?? os.homedir(), NABY_HARNESS_DIR)];
  }
  if (args.scope === 'project') {
    // A scopeKey that is not an absolute path cannot address a directory; refuse
    // rather than resolving it against whatever cwd the server happens to have.
    return path.isAbsolute(args.scopeKey)
      ? [path.join(args.scopeKey, NABY_HARNESS_DIR)]
      : [];
  }
  return [];
}

/** The content directories a harness home holds. A delete may never target one
 *  of these (or the base itself): removing `skills/` would take out every skill
 *  to satisfy a request about one. */
const CONTENT_DIRS = ['skills', 'commands', 'agents'];

export type HarnessDeletePlan =
  | {
      tier: 'source';
      /** Absolute path to unlink — a file, or a skill directory. */
      target: string;
      /** Whether `target` is a directory (the `skills/<name>/SKILL.md` layout). */
      recursive: boolean;
      /** The naby home `target` was found under — re-checked against realpaths. */
      base: string;
    }
  | {
      tier: 'tombstone';
      /** Why no file is being touched — surfaced in tests and the action result. */
      reason: 'no-origin' | 'outside-naby-home';
    };

/** Lexical containment: `target` is strictly inside `base` (never the base
 *  itself, never a sibling whose name merely starts the same — the `+ sep` is
 *  what stops `/a/.naby-old` matching `/a/.naby`). Mirrors src/lib/fsScope's
 *  withinCwd, which lives in the Next app tree and is not importable from a
 *  feature package (MODULES.md: packages must not depend on src/). */
export function strictlyWithin(base: string, target: string): boolean {
  const b = path.resolve(base);
  const t = path.resolve(target);
  return t !== b && t.startsWith(b + path.sep);
}

/**
 * Decide what deleting this row means, from the path as recorded. Pure.
 *
 * The skill-directory rule keys on the FILENAME, not on the kind: `SKILL.md` is
 * the canonical layout's marker, and its parent directory is the skill. A flat
 * `skills/<name>.md`, a command `commands/<verb>.md` and an agent
 * `agents/<name>.md` are each just their file. A nested pack skill
 * (`skills/<pack>/<skill>/SKILL.md`) removes the `<skill>` directory and leaves
 * the pack — the pack's other skills are not what was deleted.
 */
export function planHarnessDelete(
  item: Pick<HarnessItem, 'scope' | 'scopeKey' | 'provenance'>,
  opts?: { homeDir?: string },
): HarnessDeletePlan {
  const origin = item.provenance.origin;
  // No origin at all (a user-authored command, a set import: `set:name@1.0`) or
  // a non-path origin: there is no file, so there is nothing to unlink. Such a
  // row is tombstoned rather than hard-deleted for one reason — the SCAN keys on
  // (kind, name), and a hard delete of a row whose name a `.claude` artifact also
  // claims would let that artifact re-appear as a new row. The tombstone is the
  // uniform answer, and it is restorable.
  if (typeof origin !== 'string' || origin.length === 0 || !path.isAbsolute(origin)) {
    return { tier: 'tombstone', reason: 'no-origin' };
  }

  const bases = nabyHarnessBases({
    scope: item.scope,
    scopeKey: item.scopeKey,
    ...(opts?.homeDir ? { homeDir: opts.homeDir } : {}),
  });
  const base = bases.find((b) => strictlyWithin(b, origin));
  if (!base) return { tier: 'tombstone', reason: 'outside-naby-home' };

  const isSkillDoc = path.basename(origin).toLowerCase() === 'skill.md';
  const target = isSkillDoc ? path.dirname(origin) : origin;

  // A skill directory that IS a content dir (`skills/SKILL.md` — malformed, but
  // it is a path off a disk we did not write) would take every skill with it.
  // Refuse and tombstone instead.
  if (!strictlyWithin(base, target)) {
    return { tier: 'tombstone', reason: 'outside-naby-home' };
  }
  const rel = path.relative(base, target);
  const segments = rel.split(path.sep);
  if (segments.length <= 1 && CONTENT_DIRS.includes(segments[0] ?? '')) {
    return { tier: 'tombstone', reason: 'outside-naby-home' };
  }

  return { tier: 'source', target, recursive: isSkillDoc, base };
}

// ---------------------------------------------------------------------------
// The deletion itself — realpath containment, then unlink.
// ---------------------------------------------------------------------------

export type HarnessSourceDeleteResult =
  /** The file/directory was removed. */
  | { outcome: 'deleted'; target: string }
  /** There was nothing there — already gone, so the row can be hard-deleted too. */
  | { outcome: 'missing'; target: string }
  /** Containment failed (a symlink escape, a vanished base). Caller tombstones. */
  | { outcome: 'refused'; target: string; reason: string };

/**
 * Unlink a tier-1 target after re-deriving containment from REALPATHS.
 *
 * Why realpaths rather than trusting `planHarnessDelete`: the plan reasons about
 * the path as written, and `~/.naby/skills/evil/SKILL.md` can be a symlink whose
 * real location is `~/.claude/skills/real/SKILL.md` or `/etc`. Resolving both the
 * base and the target and re-checking containment is the only version of this
 * check that a symlink cannot walk around. A base that does not resolve (no
 * `.naby` on disk) is itself a refusal — with no home there is nothing this
 * function is allowed to be inside of.
 */
export function deleteHarnessSource(
  plan: Extract<HarnessDeletePlan, { tier: 'source' }>,
  fs: SourceFs = nodeFs as unknown as SourceFs,
): HarnessSourceDeleteResult {
  let realBase: string;
  try {
    realBase = fs.realpathSync(plan.base);
  } catch {
    return { outcome: 'refused', target: plan.target, reason: 'harness home not found' };
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(plan.target);
  } catch {
    // Nothing on disk at that path (already deleted by hand, or a broken link).
    // Not a refusal: there is no file left to resurrect the row, so the caller
    // may hard-delete it.
    return { outcome: 'missing', target: plan.target };
  }

  if (!strictlyWithin(realBase, realTarget)) {
    return {
      outcome: 'refused',
      target: plan.target,
      reason: `resolved path escapes the naby harness home (${realTarget})`,
    };
  }

  // The kind of thing we are about to remove must match the plan: a `recursive`
  // plan may only remove a directory, a file plan only a file. A mismatch means
  // the disk is not what the row described, and guessing is not this function's
  // job.
  try {
    const st = fs.statSync(realTarget);
    if (plan.recursive ? !st.isDirectory() : !st.isFile()) {
      return {
        outcome: 'refused',
        target: plan.target,
        reason: 'target is not the kind of node the row described',
      };
    }
  } catch {
    return { outcome: 'missing', target: plan.target };
  }

  try {
    // The REAL path is what gets removed — never the symlinked one, which would
    // delete the link and leave the file (or, for a directory link, do nothing
    // useful). `force` keeps a race with an external deletion from throwing.
    fs.rmSync(realTarget, { recursive: plan.recursive, force: true });
    return { outcome: 'deleted', target: plan.target };
  } catch (e) {
    return {
      outcome: 'refused',
      target: plan.target,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}
