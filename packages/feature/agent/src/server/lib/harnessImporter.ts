/**
 * The naby harness importer — walks a harness home, parses artifacts, writes rows
 * (Phase 1.6 HP-04; harness-standalone §2.1/§2.2).
 *
 * WHY THIS EXISTS. The owner's original question — "import someone else's harness,
 * pull in just certain skills" — needs a way to read the on-disk Claude Code
 * artifacts (command `.md`, `SKILL.md`, agent `.md`) and turn them
 * into Naby-OWNED, scoped rows. This module does the READ + PARSE + gate-write:
 * it walks a harness base directory, parses the YAML-frontmatter + markdown of
 * each artifact into a normalized `HarnessItem` payload, and pushes it through the
 * store's import gate (`putHarnessItem`, contract §4) with `provenance.source =
 * 'external'`. The gate FORCES every imported item to `status:'disabled'` — the
 * item is inert until the owner reviews and enables it in the HP-06 review UI.
 *
 * TWO MODES, AND THE DIFFERENCE IS THE WHOLE POINT (harness-standalone §1).
 * naby is a STANDALONE app: it has no standing connection to another product's
 * harness directory. But importing one is fine — importing it MAKES IT NABY'S.
 *
 *   mode:'scan' (the default, and what scan-on-list runs before every harness
 *     list) reads the NABY HARNESS HOME ONLY — `~/.naby/{commands,skills,agents}`
 *     or `<cwd>/.naby/...`. It never opens `.claude`. That is what stops a vendor
 *     directory being a live second source of truth that reappears in the list
 *     after every refresh, forever, with no user action behind it.
 *
 *   mode:'import' (the explicit Import button, and nothing else) ALSO reads the
 *     vendor bases (`~/.claude`, `<cwd>/.claude`) — and MATERIALIZES what it
 *     finds: each accepted artifact is COPIED into the corresponding naby home
 *     path FIRST, and the row's `provenance.origin` names the COPY. The vendor
 *     path survives only as `provenance.importedFrom`, which nothing reads back.
 *     After an import there is no live path from a naby row to a vendor file.
 *
 * WHY COPY RATHER THAN POINT. A row whose origin lives under `~/.claude` is a
 * standing dependency on another product's directory: the file can change or
 * vanish underneath us, deleting the item cannot delete the file (so it needs a
 * tombstone), and "my harness" turns out to be a set of pointers into a vendor
 * tree. Copying makes the import mean what the button says. The vendor file is
 * left exactly where it is — naby reads it once and never writes to it.
 *
 * A COPY NEVER OVERWRITES A NABY FILE. If the destination already exists the
 * artifact is SKIPPED and reported, because the naby home is the owner's own
 * directory and an import is not a licence to rewrite it. If the copy FAILS
 * (permissions, a vanished source) the artifact is skipped and reported too — a
 * DB row pointing at a file that was never written is the one outcome worse than
 * not importing.
 *
 * WHEN BOTH BASES CLAIM ONE NAME, THE NABY HOME WINS and the vendor file is
 * skipped for the rest of that walk. Not merely a preference: the two files are
 * different origins for one `(scope,scopeKey,kind,name)` identity, so importing
 * both would send the second through the gate as a TAKEOVER — overwriting the
 * body and (correctly, for a takeover) forcing the row back to disabled. It is
 * also what makes re-pressing Import idempotent: the copy made on the first press
 * is found in the naby home on the second, and its vendor twin is shadowed before
 * anything is copied again.
 *
 * HOOKS ARE NEVER IMPORTED (contract §4 invariant 3). Claude Code hooks are
 * arbitrary executable code; importing them would be arbitrary-code-execution.
 * This module NEVER reads a hook's body into the store — it only COUNTS how many
 * hook definitions it saw (in `settings.json` and a `hooks/` dir) so the result
 * can report "N hooks skipped", then drops them.
 *
 * RE-IMPORT IS UPSERT, NOT DUPLICATE. The store keys rows by
 * `(scope, scopeKey, kind, name)`, so importing the same `~/.claude` twice
 * updates the rows in place rather than piling up copies.
 *
 * A RE-IMPORT MUST NOT UNDO THE USER'S REVIEW. Since v1.8.1 this walk also runs
 * before every Settings list (scan-on-list), which turned "upsert" into a repeat
 * offender: each re-run pushed the same rows through the gate as fresh external
 * imports, and the gate pins external writes to 'disabled' — so enabling an
 * imported skill was silently reverted by the next list and "/" stayed empty.
 * Two things fix that here, in order:
 *   1. UNCHANGED ARTIFACTS ARE NOT WRITTEN AT ALL. The walk reads the store's
 *      current rows first and skips any artifact whose content still matches,
 *      so the common re-scan is a pure read (no status churn, no updatedAt
 *      churn, no sqlite writes per keystroke of panel refreshing).
 *   2. CHANGED ARTIFACTS ARE WRITTEN AS A REFRESH (`refresh: true`), which tells
 *      the gate to carry the existing row's status through (harness-gate.ts
 *      invariant 5). Content may change on a re-read; the trust decision may not.
 * Neither weakens the gate for NEW rows: a first sighting has no stored status,
 * so it still lands disabled and inert until reviewed.
 *
 * NOR MUST IT UNDO THE USER'S DELETE (v1.8.2). The same two paths carry a
 * TOMBSTONE (status:'removed') for free, and that is what makes a delete stick:
 * deleting an item whose file naby does not own removes the row's visibility but
 * not the file, so without a remembered row this walk re-imported the artifact on
 * the very next list as a brand-new disabled item — the user deleted A, B, C and
 * watched them reappear after D…Z. Unchanged ⇒ skipped, changed ⇒ refreshed with
 * 'removed' carried through. Neither ever produces a second row. Since §2.2 the
 * tombstone is mostly a BACKWARD-COMPATIBILITY device (harness-standalone §2.6):
 * a new import owns its file and deletes it outright, so only rows imported
 * before this change — and set imports, which have no file at all — still need
 * one. It stays because those rows are on real disks.
 *
 * A NABY-HOME ARRIVAL IS LIVE ON ARRIVAL (v1.9.1, harness-gate invariant 7).
 * Everything above kept a NEW row disabled, which was right while "new row" meant
 * "a file we found in somebody else's directory". It stopped being right when the
 * skill-hub chat flow started installing INTO the naby harness home: the user asks
 * for a skill in chat, the turn is gated and visible, the file lands in `~/.naby`
 * — and then the skill does nothing until they find Settings and press a switch
 * nothing told them about. So an artifact read from a NABY BASE is written with
 * `autoEnable: true` and the gate grants the requested 'enabled' — for a NEW row
 * only.
 *   WHICH ARTIFACTS. Only ones read from a naby base (`job.vendor === false`)
 *   whose origin is strictly inside one of `nabyHarnessBases(...)` — the same
 *   function the delete tiers use to decide "is this file ours", so the two
 *   answers cannot drift into a state where a row auto-enables but its file is
 *   treated as a stranger's. A vendor artifact does NOT qualify even though the
 *   copy lands in the naby home: what the flag records is that the ARRIVAL was
 *   user-driven, and a `.claude` tree merely exists on disk.
 *   WHAT IS UNAFFECTED. Existing rows — the flag is inert for them (invariant 7
 *   checks `!existing`), so a skill the user disabled stays disabled through every
 *   later scan, exactly as invariant 5 already promised. Tombstones, set imports
 *   and unknown origins are untouched.
 *   THE KILL SWITCH. `harness.autoEnableNabyHome` (default ON). Read HERE, once
 *   per walk, and passed to the gate as a decided boolean — the gate is pure and
 *   reads no settings.
 *
 * INJECTABLE fs + store + homeDir. The filesystem, the store slice, and the home
 * directory are all parameters (defaulting to node `fs` / `getStore()` /
 * `os.homedir()`), so the whole walk+parse+gate flow is unit-testable against an
 * in-memory fake fs and a fake store without touching a real disk or sqlite file.
 */

import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { CLAUDE_HARNESS_DIR, NABY_HARNESS_DIR } from './harnessHome';
// ONE definition of "this file is under a naby harness home", shared with the
// delete tiers (harnessSource.ts). Auto-enable and tier-1 delete are the same
// claim — "naby owns this file" — so they must not be two implementations.
import { nabyHarnessBases, strictlyWithin } from './harnessSource';
import type {
  HarnessImportRequest,
  HarnessItem,
  HarnessKind,
  HarnessScope,
  HarnessStatus,
} from '../../../../../../../dist/naby-runtime.mjs';

// ---------------------------------------------------------------------------
// Injectable seams.
// ---------------------------------------------------------------------------

/** The tiny slice of node `fs` the importer reads through — an injectable seam so
 *  tests can drive it with an in-memory tree instead of a real disk.
 *
 *  THE WRITE CALLS ARE OPTIONAL, and only the materializing import (mode:'import',
 *  harness-standalone §2.1) uses them. A fake fs that omits them is not broken —
 *  it simply cannot materialize, and every vendor artifact is skipped with that
 *  said in the summary. Read-only by default is the right default for a module
 *  whose day job is a read. */
export interface ImporterFs {
  existsSync(p: string): boolean;
  readFileSync(p: string, encoding: 'utf8'): string;
  readdirSync(
    p: string,
    opts: { withFileTypes: true },
  ): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  /** Create the destination's parent chain. Recursive, so an untouched naby home
   *  materializes on the first import. */
  mkdirSync?(p: string, opts: { recursive: true }): unknown;
  /** Copy ONE file (a flat `skills/<name>.md`, a command, an agent). */
  copyFileSync?(src: string, dest: string): void;
  /** Copy a whole skill DIRECTORY — `SKILL.md` plus its references/, scripts/,
   *  assets/. `errorOnExist` + `force:false` is a second guard under the caller's
   *  own existence check: an import must never rewrite a naby-owned file. */
  cpSync?(
    src: string,
    dest: string,
    opts: { recursive: true; errorOnExist: true; force: false },
  ): void;
}

/** The store slice the importer writes through — the gate entry point, plus an
 *  OPTIONAL read used to skip re-writing artifacts that have not changed. The
 *  read is optional so a caller with a write-only fake still works; without it
 *  the walk simply writes every artifact as a refresh (still status-preserving,
 *  just less frugal). */
export interface ImporterStore {
  putHarnessItem(req: HarnessImportRequest): HarnessItem;
  listHarness?(
    scope: HarnessScope,
    scopeKey: string,
    opts?: { kind?: HarnessKind; status?: HarnessStatus },
  ): HarnessItem[];
  /** The kill switch for naby-home auto-enable (`harness.autoEnableNabyHome`).
   *  OPTIONAL like the read above: a store that cannot answer gets the documented
   *  DEFAULT (on), because the default is a product decision and a fake store's
   *  silence is not a user turning something off. */
  getSetting?(key: string): string | undefined;
}

// ---------------------------------------------------------------------------
// The naby-home auto-enable switch (harness-gate invariant 7).
// ---------------------------------------------------------------------------

/** Settings key for "a skill installed into the naby harness home arrives ON".
 *  Namespaced like the memory opt-in (`memory.autoConfirmCorroborated`). */
export const HARNESS_AUTO_ENABLE_KEY = 'harness.autoEnableNabyHome';

/**
 * Is naby-home auto-enable on? DEFAULT ON — the whole point is that a skill the
 * user asked for in chat works without a second, undiscoverable click.
 *
 * Stored as '1'/'0' and read as "anything that is not '0' is on", so an unset key
 * (the overwhelming case) and a malformed value both fall to the default rather
 * than silently disabling a feature the user never turned off. Turning it OFF is
 * an explicit write of '0' from the settings toggle.
 */
export function readAutoEnableNabyHome(store: Pick<ImporterStore, 'getSetting'>): boolean {
  if (!store.getSetting) return true;
  try {
    return (store.getSetting(HARNESS_AUTO_ENABLE_KEY) ?? '1') !== '0';
  } catch {
    // A settings read that throws must not change what lands; the default holds.
    return true;
  }
}

/** Write the switch. '1'/'0' rather than 'true'/'false' so an unset key and an
 *  explicit off are distinguishable at a glance in the settings table. */
export function writeAutoEnableNabyHome(
  store: { setSetting(key: string, value: string): void },
  enabled: boolean,
): void {
  store.setSetting(HARNESS_AUTO_ENABLE_KEY, enabled ? '1' : '0');
}

// ---------------------------------------------------------------------------
// Result summary.
// ---------------------------------------------------------------------------

export interface HarnessImportSkip {
  origin: string;
  kind?: HarnessKind;
  reason: string;
}

export interface HarnessImportSummary {
  scope: HarnessScope;
  scopeKey: string;
  /** The FIRST base that actually existed (absolute) — or, when none did, the
   *  first base that WOULD have been read (the naby home), which is the path the
   *  "nothing to import" message should name. Kept as a single string because it
   *  is what the review UI prints; use `baseDirs` for anything that must cover
   *  every base (e.g. reverting an import by origin prefix). */
  baseDir: string;
  /** Every base this run considered, in read order. A SCAN lists the naby harness
   *  home and nothing else; an explicit IMPORT lists the naby home first and the
   *  vendor `.claude` second. Present even for bases that do not exist. */
  baseDirs: string[];
  /** Whether ANY of those bases existed — a clean "nothing to import" signal. */
  baseExists: boolean;
  /** Count of rows PRESENT after the walk, per kind — written this run or
   *  already stored unchanged. (A new row lands disabled; an existing one keeps
   *  the status the user gave it.) */
  imported: { command: number; skill: number; subagent: number };
  /** How many of those needed no write because the file's content already
   *  matched the stored row. On a steady-state re-scan this equals the total —
   *  the signal that scan-on-list is costing nothing. */
  unchanged: number;
  /** How many artifacts were COPIED into the naby harness home by this run
   *  (harness-standalone §2.1). Always 0 for a scan, which reads only files that
   *  are already naby's. A non-zero count is the proof the import materialized
   *  rather than merely pointing at a vendor tree. */
  copied: number;
  /** How many hook definitions were seen and DROPPED (never imported). */
  skippedHooks: number;
  /** Artifacts skipped without an error (e.g. an empty body). */
  skipped: HarnessImportSkip[];
  /** Artifacts the gate or a read rejected (e.g. a lower-tier overwrite). */
  failed: Array<{ origin: string; error: string }>;
  /** The rows that landed, WHOLE — the review UI renders these immediately. */
  items: HarnessItem[];
}

// ---------------------------------------------------------------------------
// Frontmatter + value helpers.
// ---------------------------------------------------------------------------

/**
 * Split a markdown document into its leading YAML frontmatter (parsed to an
 * object) and the remaining body. Degrades gracefully: a document with no
 * frontmatter, or with empty/unparseable/non-object frontmatter, yields
 * `{ data: {}, body: <whole trimmed text> }` rather than throwing.
 */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const text = raw.replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text.trim() };
  let data: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(m[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return { data, body: text.slice(m[0].length).trim() };
}

/** First present key's value, or undefined. */
function pick(data: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (k in data) return data[k];
  return undefined;
}

/** A non-empty trimmed string, or undefined. */
function asString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Normalize a tool/trigger list. Claude frontmatter expresses these either as a
 * YAML sequence (`tools:\n  - Read`) or a comma-separated scalar
 * (`tools: Read, Write, Bash`); both flatten to a string[]. Undefined when empty.
 */
function asStringList(v: unknown): string[] | undefined {
  let arr: string[];
  if (Array.isArray(v)) {
    arr = v.map((x) => String(x).trim()).filter(Boolean);
  } else if (typeof v === 'string') {
    arr = v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    return undefined;
  }
  return arr.length > 0 ? arr : undefined;
}

// ---------------------------------------------------------------------------
// Per-kind parsers — a raw artifact -> the kind-specific slice of a HarnessItem.
// Exported for direct unit testing.
// ---------------------------------------------------------------------------

export interface ParsedHarness {
  name: string;
  description?: string;
  command?: HarnessItem['command'];
  skill?: HarnessItem['skill'];
  subagent?: HarnessItem['subagent'];
}

/** command `.md`: frontmatter `description`/`argument-hint`, body is the template. */
export function parseCommandArtifact(name: string, raw: string): ParsedHarness | null {
  const { data, body } = parseFrontmatter(raw);
  if (body.length === 0) return null;
  const description = asString(pick(data, 'description'));
  const argumentHint = asString(pick(data, 'argument-hint', 'argumentHint'));
  return {
    name,
    ...(description ? { description } : {}),
    command: { template: body, ...(argumentHint ? { argumentHint } : {}) },
  };
}

/** SKILL.md: frontmatter `name`/`description`/`triggers`/tools, body is instructions. */
export function parseSkillArtifact(fallbackName: string, raw: string): ParsedHarness | null {
  const { data, body } = parseFrontmatter(raw);
  if (body.length === 0) return null;
  const name = asString(pick(data, 'name')) ?? fallbackName;
  const description = asString(pick(data, 'description'));
  const triggers = asStringList(pick(data, 'triggers', 'trigger'));
  const toolRefs = asStringList(pick(data, 'allowed-tools', 'allowedTools', 'tools'));
  return {
    name,
    ...(description ? { description } : {}),
    skill: {
      instructions: body,
      ...(triggers ? { triggers } : {}),
      ...(toolRefs ? { toolRefs } : {}),
    },
  };
}

/** agent `.md`: frontmatter `name`/`description`/`model`/`tools`, body is the prompt. */
export function parseSubagentArtifact(fallbackName: string, raw: string): ParsedHarness | null {
  const { data, body } = parseFrontmatter(raw);
  if (body.length === 0) return null;
  const name = asString(pick(data, 'name')) ?? fallbackName;
  const description = asString(pick(data, 'description'));
  const model = asString(pick(data, 'model'));
  const toolRefs = asStringList(pick(data, 'tools', 'allowed-tools', 'allowedTools'));
  return {
    name,
    ...(description ? { description } : {}),
    subagent: {
      systemPrompt: body,
      ...(model ? { model } : {}),
      ...(toolRefs ? { toolRefs } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Directory walking.
// ---------------------------------------------------------------------------

function safeReaddir(fs: ImporterFs, dir: string) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeRead(fs: ImporterFs, file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

interface RawArtifact {
  /** The verb / skill / subagent name derived from the path. */
  name: string;
  /**
   * A containing folder that must qualify the final name (skill PACKS, below).
   * Applied by the driver AFTER parsing, because a SKILL.md's frontmatter `name`
   * overrides the path-derived one — two packs shipping a skill called `review`
   * would otherwise collide on the store's (scope,scopeKey,kind,name) identity
   * and silently overwrite each other.
   */
  namePrefix?: string;
  /** Absolute path — becomes provenance.origin (rollback/display handle). */
  origin: string;
  content: string;
}

/** Join a name to its pack qualifier. HYPHEN, not `:` or `/`: an imported item's
 *  name has to stay TYPABLE and dispatchable in the "/" palette, and both the
 *  server dispatcher (slashCommands' COMMAND_LINE_RE) and the client
 *  autocomplete accept `[a-zA-Z][a-zA-Z0-9-]*` only — a `pack:skill` row would
 *  list in Settings and then refuse to run. Same convention `readCommands`
 *  already uses for namespaced command folders. */
function qualify(prefix: string | undefined, name: string): string {
  return prefix ? `${prefix}-${name}` : name;
}

/** Recursively read every command `.md` under commands/ so namespaced command
 *  folders are captured; a nested path flattens to a hyphen-joined name
 *  (`git/commit.md` -> `git-commit`). */
function readCommands(fs: ImporterFs, commandsDir: string): RawArtifact[] {
  const out: RawArtifact[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const ent of safeReaddir(fs, dir)) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, prefix ? `${prefix}-${ent.name}` : ent.name);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        const base = ent.name.slice(0, -3);
        const name = prefix ? `${prefix}-${base}` : base;
        const content = safeRead(fs, full);
        if (content !== null) out.push({ name, origin: full, content });
      }
    }
  };
  walk(commandsDir, '');
  return out;
}

/**
 * skills/<name>/SKILL.md (canonical), skills/<name>.md (flat), and ONE extra
 * level for PACKS: skills/<pack>/<skill>/SKILL.md.
 *
 * The nested level is not hypothetical — a marketplace/hub install lands a whole
 * bundle as `skills/<pack>/<skill>/SKILL.md`, and reading only the top level
 * meant every skill in such a pack was silently ignored by the importer (the
 * pack folder has no SKILL.md of its own, so it looked like an empty skill).
 * Nested items carry the pack as a name qualifier so two packs can ship the same
 * skill name without one overwriting the other.
 *
 * Exactly one extra level, deliberately: deeper trees under a skill folder are
 * its RESOURCES (references/, scripts/, assets/), not more skills, and walking
 * them would import documentation as capabilities.
 */
function readSkills(fs: ImporterFs, skillsDir: string): RawArtifact[] {
  const out: RawArtifact[] = [];
  for (const ent of safeReaddir(fs, skillsDir)) {
    if (ent.isDirectory()) {
      const dir = path.join(skillsDir, ent.name);
      const skillFile = path.join(dir, 'SKILL.md');
      const content = safeRead(fs, skillFile);
      if (content !== null) out.push({ name: ent.name, origin: skillFile, content });
      // Treat the same directory as a possible PACK. A folder can legitimately be
      // both (its own SKILL.md plus sub-skills), so this is not an `else`.
      for (const sub of safeReaddir(fs, dir)) {
        if (!sub.isDirectory()) continue;
        const nestedFile = path.join(dir, sub.name, 'SKILL.md');
        const nested = safeRead(fs, nestedFile);
        if (nested !== null) {
          out.push({
            name: sub.name,
            namePrefix: ent.name,
            origin: nestedFile,
            content: nested,
          });
        }
      }
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      const full = path.join(skillsDir, ent.name);
      const content = safeRead(fs, full);
      if (content !== null) out.push({ name: ent.name.slice(0, -3), origin: full, content });
    }
  }
  return out;
}

/** agents/*.md (top-level). */
function readAgents(fs: ImporterFs, agentsDir: string): RawArtifact[] {
  const out: RawArtifact[] = [];
  for (const ent of safeReaddir(fs, agentsDir)) {
    if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      const full = path.join(agentsDir, ent.name);
      const content = safeRead(fs, full);
      if (content !== null) out.push({ name: ent.name.slice(0, -3), origin: full, content });
    }
  }
  return out;
}

/**
 * COUNT (never read) hook definitions so the summary can report them dropped.
 * Two sources: a `hooks/` directory of scripts, and `settings.json`'s `hooks`
 * map (event -> matchers -> hooks[]). Neither body is ever stored.
 */
function countHooks(fs: ImporterFs, baseDir: string): number {
  let count = 0;
  // 1) a hooks/ directory of executable scripts.
  for (const ent of safeReaddir(fs, path.join(baseDir, 'hooks'))) {
    if (ent.isFile()) count++;
  }
  // 2) settings.json hooks map.
  const settingsRaw = safeRead(fs, path.join(baseDir, 'settings.json'));
  if (settingsRaw) {
    try {
      const parsed = JSON.parse(settingsRaw) as { hooks?: Record<string, unknown> };
      const hooks = parsed.hooks;
      if (hooks && typeof hooks === 'object') {
        for (const matchers of Object.values(hooks)) {
          if (Array.isArray(matchers)) {
            for (const m of matchers) {
              const inner = (m as { hooks?: unknown })?.hooks;
              count += Array.isArray(inner) ? inner.length : 1;
            }
          } else {
            count += 1;
          }
        }
      }
    } catch {
      // Malformed settings.json — nothing countable, nothing imported.
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Change detection — "is this artifact already stored exactly as it is on disk?"
// ---------------------------------------------------------------------------

/** The store's upsert identity, minus the scope pair the index is already keyed
 *  by: kind + name. */
function identityKey(kind: HarnessKind, name: string): string {
  return `${kind} ${name}`;
}

/** Read the rows already stored for this scope, indexed by (kind, name). Falls
 *  back to an EMPTY index when the store exposes no read or the read throws: an
 *  empty index only costs writes, it never changes what lands.
 *
 *  DELIBERATELY UNFILTERED BY STATUS — the tombstones (status:'removed') are the
 *  most important rows in it. A tombstone is a delete the user performed on an
 *  artifact whose file naby does not own; leaving it out of this index would make
 *  its file look unseen, and the walk would import it as a fresh disabled row,
 *  which is the exact bug the tombstone exists to prevent. */
function readExistingRows(
  store: ImporterStore,
  scope: HarnessScope,
  scopeKey: string,
): Map<string, HarnessItem> {
  const index = new Map<string, HarnessItem>();
  if (!store.listHarness) return index;
  try {
    for (const row of store.listHarness(scope, scopeKey)) {
      index.set(identityKey(row.kind, row.name), row);
    }
  } catch {
    /* a failed read just means every artifact is written */
  }
  return index;
}

/** Order-insensitive-free comparison of an optional string list (order IS part
 *  of the value here — `tools: Read, Bash` is stored as authored). */
function sameList(a?: string[], b?: string[]): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Does the stored row already carry exactly what this artifact parsed to?
 *
 * Compares the FIELDS THE IMPORTER AUTHORS only — description and the kind
 * payload. Deliberately NOT compared: `provenance.importedAt` (a fresh timestamp
 * every walk, which would make every scan look changed) and `status` (the user's
 * decision, which the importer never authors). The caller checks `origin`
 * separately, because a different file claiming the same identity must be
 * written even when its body happens to match.
 */
export function sameHarnessContent(existing: HarnessItem, parsed: ParsedHarness): boolean {
  if ((existing.description ?? undefined) !== (parsed.description ?? undefined)) return false;

  if (existing.command || parsed.command) {
    if (!existing.command || !parsed.command) return false;
    if (existing.command.template !== parsed.command.template) return false;
    if (existing.command.argumentHint !== parsed.command.argumentHint) return false;
  }
  if (existing.skill || parsed.skill) {
    if (!existing.skill || !parsed.skill) return false;
    if (existing.skill.instructions !== parsed.skill.instructions) return false;
    if (!sameList(existing.skill.triggers, parsed.skill.triggers)) return false;
    if (!sameList(existing.skill.toolRefs, parsed.skill.toolRefs)) return false;
  }
  if (existing.subagent || parsed.subagent) {
    if (!existing.subagent || !parsed.subagent) return false;
    if (existing.subagent.systemPrompt !== parsed.subagent.systemPrompt) return false;
    if (existing.subagent.model !== parsed.subagent.model) return false;
    if (!sameList(existing.subagent.toolRefs, parsed.subagent.toolRefs)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The import driver.
// ---------------------------------------------------------------------------

/** What a walk is FOR — and, therefore, which directories it may open.
 *
 *  'scan'   the naby harness home only. Runs before every harness list; no user
 *           action stands behind it, so it may not reach into another product's
 *           directory (harness-standalone §2.2).
 *  'import' the naby home PLUS the vendor bases, with every vendor artifact
 *           copied into the naby home before its row is written (§2.1). Only the
 *           explicit Import button asks for this. */
export type HarnessWalkMode = 'scan' | 'import';

export interface ImportHarnessArgs {
  scope: HarnessScope;
  scopeKey: string;
  /** Default 'scan'. See HarnessWalkMode — this is the ONLY thing that decides
   *  whether a vendor directory is opened. */
  mode?: HarnessWalkMode;
  /** For user scope, the `.naby` (and, on an import, `.claude`) under this home
   *  dir. Defaults to os.homedir(). An injected seam so tests never read a real
   *  home. */
  homeDir?: string;
  /** For project scope, the project root whose `.naby/` (and, on an import,
   *  `.claude/`) is read. */
  cwd?: string;
  store: ImporterStore;
  fs?: ImporterFs;
}

/**
 * Resolve a scope's NABY harness bases — the only directories a walk reads
 * unconditionally (harness-standalone §2.2).
 *
 * `.claude` is deliberately absent. It used to be here, which made every harness
 * list a re-read of a vendor tree naby does not own: an item deleted there came
 * back, a file installed there arrived without anyone asking, and "standalone
 * app" was not true of the code. Vendor bases now come from `resolveVendorBases`
 * and are reachable from ONE call site (the explicit import), which is what makes
 * that property checkable rather than merely intended.
 *
 * Returns null for a scope with no on-disk home at all: `org` is populated by a
 * set import, and `project` without a cwd has no root to look under. Bases that
 * do not exist are NOT filtered here; the walk treats a missing directory as
 * empty, which is the ordinary case for a user who has never installed anything.
 */
export function resolveBaseDirs(args: {
  scope: HarnessScope;
  homeDir?: string;
  cwd?: string;
}): string[] | null {
  if (args.scope === 'user') {
    return [path.join(args.homeDir ?? os.homedir(), NABY_HARNESS_DIR)];
  }
  if (args.scope === 'project') {
    return args.cwd ? [path.join(args.cwd, NABY_HARNESS_DIR)] : null;
  }
  // org scope has no local harness directory on disk in single-user builds.
  return null;
}

/**
 * Resolve a scope's VENDOR bases — the directories an explicit import may read
 * FROM, once, in order to copy out of them.
 *
 * SEPARATE FROM `resolveBaseDirs` ON PURPOSE. These two answers were one function
 * and the result was that everything which walked a harness tree walked `.claude`
 * too, whether or not the user had asked for it. Keeping them apart means a
 * vendor path can only enter the program through a caller that named this
 * function, and there is exactly one (importHarness, under mode:'import').
 */
export function resolveVendorBases(args: {
  scope: HarnessScope;
  homeDir?: string;
  cwd?: string;
}): string[] {
  if (args.scope === 'user') {
    return [path.join(args.homeDir ?? os.homedir(), CLAUDE_HARNESS_DIR)];
  }
  if (args.scope === 'project') {
    return args.cwd ? [path.join(args.cwd, CLAUDE_HARNESS_DIR)] : [];
  }
  return [];
}

const KIND_ORDER: HarnessKind[] = ['command', 'skill', 'subagent'];

/** One base's three kinds of raw artifacts, paired with how to parse them. */
function jobsForBase(
  fs: ImporterFs,
  baseDir: string,
): Array<{
  kind: HarnessKind;
  format: NonNullable<HarnessItem['provenance']['format']>;
  raws: RawArtifact[];
  parse: (name: string, content: string) => ParsedHarness | null;
}> {
  return [
    {
      kind: 'command',
      format: 'claude-command-md',
      raws: readCommands(fs, path.join(baseDir, 'commands')),
      parse: parseCommandArtifact,
    },
    {
      kind: 'skill',
      format: 'claude-skill-md',
      raws: readSkills(fs, path.join(baseDir, 'skills')),
      parse: parseSkillArtifact,
    },
    {
      kind: 'subagent',
      format: 'claude-agent-md',
      raws: readAgents(fs, path.join(baseDir, 'agents')),
      parse: parseSubagentArtifact,
    },
  ];
}

// ---------------------------------------------------------------------------
// Materialization — "importing it makes it mine" (harness-standalone §2.1).
// ---------------------------------------------------------------------------

/** What a copy attempt produced. `origin` is the path the ROW must record: the
 *  file naby now owns. */
export type MaterializeResult =
  | { outcome: 'copied'; origin: string }
  | { outcome: 'conflict'; origin: string; reason: string }
  | { outcome: 'failed'; reason: string };

/**
 * Copy ONE vendor artifact into the naby harness home, preserving its layout, and
 * report the naby path the row should point at.
 *
 * WHAT GETS COPIED. A `SKILL.md` takes its WHOLE DIRECTORY — a skill is not one
 * markdown file, it is that file plus the `references/`, `scripts/` and assets it
 * tells the model to read, and importing the manifest without the material it
 * names produces a skill that instructs its way into a missing file. Everything
 * else (`commands/<verb>.md`, `agents/<name>.md`, a flat `skills/<name>.md`) is
 * exactly its own file.
 *
 * WHERE IT LANDS. The path RELATIVE TO THE BASE is preserved, so
 * `~/.claude/skills/pack/review/SKILL.md` becomes
 * `~/.naby/skills/pack/review/SKILL.md`. That matters beyond tidiness: the naby
 * home is re-walked by every later scan, and the pack qualifier that keeps two
 * packs' same-named skills apart is derived from the directory nesting. Flatten
 * it and the copy would re-import under a different name than the original.
 *
 * WHAT IS REFUSED. An existing destination is a CONFLICT, never an overwrite:
 * the naby home is the owner's own directory, and "I imported someone's harness"
 * is not consent to rewrite a file already in it. The caller skips the artifact
 * and reports it. (`cpSync`'s `errorOnExist` re-checks the same thing at the
 * syscall, so a directory that appears between the check and the copy fails
 * closed rather than merging into a half-vendor, half-naby skill.)
 */
export function materializeIntoNabyHome(args: {
  fs: ImporterFs;
  /** The vendor base the artifact was read from. */
  vendorBase: string;
  /** The naby base of the same scope — where the copy goes. */
  nabyBase: string;
  /** The artifact's file path under `vendorBase`. */
  origin: string;
}): MaterializeResult {
  const { fs, vendorBase, nabyBase, origin } = args;
  const rel = path.relative(vendorBase, origin);
  // A path that does not sit under the base cannot be mapped into the naby home;
  // refusing beats guessing at a destination (`..` segments would escape it).
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { outcome: 'failed', reason: 'the artifact is not inside the base directory' };
  }
  const destFile = path.join(nabyBase, rel);

  // A skill in the canonical layout is its DIRECTORY; anything else is its file.
  const isSkillDoc = path.basename(origin).toLowerCase() === 'skill.md';
  const src = isSkillDoc ? path.dirname(origin) : origin;
  const dest = isSkillDoc ? path.dirname(destFile) : destFile;

  if (fs.existsSync(dest)) {
    return {
      outcome: 'conflict',
      origin: destFile,
      reason: `already in the naby harness home: ${dest}`,
    };
  }
  const { mkdirSync, cpSync, copyFileSync } = fs;
  const copy = isSkillDoc
    ? () => cpSync?.(src, dest, { recursive: true, errorOnExist: true, force: false })
    : () => copyFileSync?.(src, dest);
  if (!mkdirSync || (isSkillDoc ? !cpSync : !copyFileSync)) {
    return { outcome: 'failed', reason: 'this filesystem cannot write (read-only importer fs)' };
  }
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
    copy();
  } catch (e) {
    // The row is NOT written on a failed copy. A row whose origin names a file
    // that was never created is worse than a missing row: it looks imported,
    // enables like anything else, and its source can never be re-read or deleted.
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
  return { outcome: 'copied', origin: destFile };
}

/**
 * Walk a scope's harness bases and import every command/skill/subagent through
 * the gate (a new row lands disabled). Hooks are counted and dropped. Returns a
 * full summary for the review UI.
 *
 * WHICH BASES depends on `mode` and on nothing else: a scan reads the naby home,
 * an explicit import reads the naby home and then the vendor tree it copies out
 * of. See the module header.
 *
 * The format tag stays `claude-*-md` for every base on purpose: it names the FILE
 * FORMAT being parsed (Claude Code's frontmatter markdown), not the directory it
 * was found in. Which directory is the `provenance.origin`, which is the field
 * everything else — display, revert, delete-tier — actually keys on.
 */
export function importHarness(args: ImportHarnessArgs): HarnessImportSummary {
  const fs = args.fs ?? (nodeFs as unknown as ImporterFs);
  const mode: HarnessWalkMode = args.mode ?? 'scan';
  const nabyBases = resolveBaseDirs({ scope: args.scope, homeDir: args.homeDir, cwd: args.cwd });
  // ONE call site for the vendor bases, and it is gated on the explicit mode.
  const vendorBases =
    mode === 'import' && nabyBases
      ? resolveVendorBases({ scope: args.scope, homeDir: args.homeDir, cwd: args.cwd })
      : [];
  const baseDirs = nabyBases ? [...nabyBases, ...vendorBases] : null;

  const summary: HarnessImportSummary = {
    scope: args.scope,
    scopeKey: args.scopeKey,
    baseDir: baseDirs?.[0] ?? '',
    baseDirs: baseDirs ?? [],
    baseExists: false,
    imported: { command: 0, skill: 0, subagent: 0 },
    unchanged: 0,
    copied: 0,
    skippedHooks: 0,
    skipped: [],
    failed: [],
    items: [],
  };

  // The naby base the copies land in. There is one per scope (user => `~/.naby`,
  // project => `<cwd>/.naby`), so the first is the answer.
  const nabyBase = nabyBases?.[0];

  // AUTO-ENABLE ELIGIBILITY, resolved ONCE per walk (harness-gate invariant 7).
  //
  // Empty list => nothing auto-enables, which is the answer whenever the switch is
  // off AND whenever the scope has no naby home this function can name.
  //
  // `nabyHarnessBases` is the DELETE TIER's function, used deliberately: "naby
  // owns this file" must have one definition. It answers for `project` only when
  // the scopeKey is the absolute project root — which is how the route addresses a
  // project scope — so an exotic caller passing a cwd that is not its scopeKey
  // simply gets no auto-enable rather than a row whose file the delete path would
  // then decline to own.
  const autoEnableBases = readAutoEnableNabyHome(args.store)
    ? nabyHarnessBases({
        scope: args.scope,
        scopeKey: args.scopeKey,
        ...(args.homeDir ? { homeDir: args.homeDir } : {}),
      })
    : [];

  const presentBases = (baseDirs ?? []).filter((dir) => fs.existsSync(dir));
  const [firstPresent] = presentBases;
  if (!firstPresent) return summary;
  summary.baseExists = true;
  // What the UI prints: the first base that is actually there.
  summary.baseDir = firstPresent;

  // Hooks: count, then drop. Never read a hook body into the store. Counted
  // across every base, because "3 hooks skipped" is a statement about what this
  // walk saw, not about one directory.
  for (const dir of presentBases) summary.skippedHooks += countHooks(fs, dir);

  // What is already stored for this scope — read ONCE, before the walk, so an
  // artifact that has not changed can be recognized and left alone.
  const existingRows = readExistingRows(args.store, args.scope, args.scopeKey);

  const importedAt = Date.now();

  // FIRST BASE TO CLAIM A (kind, name) KEEPS IT — see the module header. Tracked
  // across the whole scan, so a later base's same-named file is skipped rather
  // than pushed through the gate as a takeover of the earlier one.
  const claimed = new Set<string>();

  // Each job remembers WHICH base it came from, because that is what decides
  // whether its artifacts must be copied before they can be rows.
  const jobs = presentBases.flatMap((dir) =>
    jobsForBase(fs, dir).map((job) => ({ ...job, baseDir: dir, vendor: vendorBases.includes(dir) })),
  );

  for (const job of jobs) {
    for (const raw of job.raws) {
      let parsed: ParsedHarness | null;
      try {
        parsed = job.parse(raw.name, raw.content);
      } catch (e) {
        summary.failed.push({ origin: raw.origin, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      if (!parsed) {
        summary.skipped.push({ origin: raw.origin, kind: job.kind, reason: 'empty body' });
        continue;
      }
      // Qualify AFTER parsing: a SKILL.md frontmatter `name` wins over the
      // path-derived one, so the pack prefix has to be applied to whatever the
      // parser settled on or two packs' same-named skills collide on the store's
      // (scope,scopeKey,kind,name) identity.
      const itemName = qualify(raw.namePrefix, parsed.name);

      // ALREADY CLAIMED BY AN EARLIER BASE? Then this file is the vendor copy of
      // something the owner keeps in their own harness home — skip it whole.
      // Importing it would be a takeover of a row this same scan just wrote: the
      // gate would replace the body and force the status back to disabled, so a
      // skill that exists in both places could never stay enabled.
      const claimKey = identityKey(job.kind, itemName);
      if (claimed.has(claimKey)) {
        summary.skipped.push({
          origin: raw.origin,
          kind: job.kind,
          reason: 'shadowed by the same name in an earlier harness base',
        });
        continue;
      }
      claimed.add(claimKey);

      // MATERIALIZE, THEN RECORD (harness-standalone §2.1). For a vendor artifact
      // the file is copied into the naby home FIRST and the row points at the
      // COPY; the vendor path survives only as the inert `importedFrom`. A
      // conflict or a failed copy skips the artifact entirely — no row is written
      // for a file that was not created.
      let origin = raw.origin;
      let importedFrom: string | undefined;
      if (job.vendor) {
        if (!nabyBase) {
          summary.skipped.push({
            origin: raw.origin,
            kind: job.kind,
            reason: 'this scope has no naby harness home to copy into',
          });
          continue;
        }
        const res = materializeIntoNabyHome({
          fs,
          vendorBase: job.baseDir,
          nabyBase,
          origin: raw.origin,
        });
        if (res.outcome !== 'copied') {
          summary.skipped.push({
            origin: raw.origin,
            kind: job.kind,
            reason:
              res.outcome === 'conflict'
                ? `not copied — ${res.reason}`
                : `copy failed — ${res.reason}`,
          });
          continue;
        }
        origin = res.origin;
        importedFrom = raw.origin;
        summary.copied += 1;
      }

      // UNCHANGED? Then write NOTHING. Scan-on-list runs this walk before every
      // harness list, and the steady state is "nothing on disk moved" — a write
      // there would only bump updated_at and re-run the gate on a row the user
      // has already ruled on. The origin must match too: a different file
      // claiming this name is a takeover and has to go through the gate.
      const stored = existingRows.get(identityKey(job.kind, itemName));
      if (
        stored &&
        stored.provenance.origin === origin &&
        sameHarnessContent(stored, parsed)
      ) {
        summary.items.push(stored);
        summary.imported[job.kind] += 1;
        summary.unchanged += 1;
        continue;
      }

      // A NEW row for a file the user had installed into their own naby harness
      // home arrives LIVE (gate invariant 7). Vendor artifacts are excluded by
      // `!job.vendor` even though their copy now sits in the naby home: the flag
      // records that the ARRIVAL was user-driven, and reading `.claude` is
      // "import everything that happens to be there", not a request for this
      // skill. The containment check is belt-and-braces over `job.vendor` — the
      // origin must actually be inside a base we would also delete files from.
      const autoEnable =
        !job.vendor && autoEnableBases.some((base) => strictlyWithin(base, origin));

      const req: HarnessImportRequest = {
        item: {
          scope: args.scope,
          scopeKey: args.scopeKey,
          kind: job.kind,
          name: itemName,
          ...(parsed.description ? { description: parsed.description } : {}),
          // source:'external' — for a NEW row the gate FORCES this to disabled
          // (contract §4 invariant 1): an imported item is inert until reviewed
          // and enabled. For an EXISTING row see `refresh` below.
          provenance: {
            source: 'external',
            // ALWAYS A PATH NABY OWNS on a fresh import: either the file was
            // already in the naby home, or it was just copied there.
            origin,
            format: job.format,
            importedAt,
            // Audit only, and only when this run copied the file in.
            ...(importedFrom ? { importedFrom } : {}),
          },
          ...(parsed.command ? { command: parsed.command } : {}),
          ...(parsed.skill ? { skill: parsed.skill } : {}),
          ...(parsed.subagent ? { subagent: parsed.subagent } : {}),
        },
        // Ask for enabled. For a vendor-sourced new row the gate downgrades
        // external to disabled regardless — asserting the import is genuinely
        // inert, not merely defaulted. For a naby-home new row the `autoEnable`
        // flag below is what lets the request through.
        requestedStatus: 'enabled',
        // Invariant 7: NEW naby-home rows only, and only while the switch is on.
        // An existing row is decided by `refresh` below, whatever this says.
        ...(autoEnable ? { autoEnable: true } : {}),
        // This walk is a RE-READ of the local tree, so a row that already exists
        // at this same origin keeps the status the user gave it (harness-gate
        // invariant 5). Only this path sets the flag: an agent-driven write goes
        // through the ordinary gate and can never move a status.
        refresh: true,
      };
      try {
        const item = args.store.putHarnessItem(req);
        summary.items.push(item);
        summary.imported[job.kind] += 1;
      } catch (e) {
        // The gate refused the row (e.g. a lower-tier overwrite). A copy already
        // made for it stays in the naby home — it is the owner's own directory,
        // the failure is reported here, and deleting files to undo a rejected
        // write is a bigger risk than leaving one visible file behind.
        summary.failed.push({ origin: raw.origin, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // Stable order for the UI: by kind, then name.
  summary.items.sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name),
  );

  return summary;
}
