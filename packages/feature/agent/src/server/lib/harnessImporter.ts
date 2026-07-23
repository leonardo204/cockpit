/**
 * `~/.claude` / `.claude` harness importer (Phase 1.6 HP-04).
 *
 * WHY THIS EXISTS. The owner's original question — "import someone else's harness,
 * pull in just certain skills" — needs a way to read the on-disk Claude Code
 * artifacts (command `.md`, `SKILL.md`, agent `.md`) and turn them
 * into Naby-OWNED, scoped rows. This module does the READ + PARSE + gate-write:
 * it walks a `.claude` base directory, parses the YAML-frontmatter + markdown of
 * each artifact into a normalized `HarnessItem` payload, and pushes it through the
 * store's import gate (`putHarnessItem`, contract §4) with `provenance.source =
 * 'external'`. The gate FORCES every imported item to `status:'disabled'` — the
 * item is inert until the owner reviews and enables it in the HP-06 review UI.
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
 * INJECTABLE fs + store + homeDir. The filesystem, the store slice, and the home
 * directory are all parameters (defaulting to node `fs` / `getStore()` /
 * `os.homedir()`), so the whole walk+parse+gate flow is unit-testable against an
 * in-memory fake fs and a fake store without touching a real disk or sqlite file.
 */

import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'js-yaml';
import type {
  HarnessImportRequest,
  HarnessItem,
  HarnessKind,
  HarnessScope,
} from '../../../../../../../dist/naby-runtime.mjs';

// ---------------------------------------------------------------------------
// Injectable seams.
// ---------------------------------------------------------------------------

/** The tiny slice of node `fs` the importer reads through — an injectable seam so
 *  tests can drive it with an in-memory tree instead of a real disk. */
export interface ImporterFs {
  existsSync(p: string): boolean;
  readFileSync(p: string, encoding: 'utf8'): string;
  readdirSync(
    p: string,
    opts: { withFileTypes: true },
  ): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
}

/** The store slice the importer writes through — only the gate entry point. */
export interface ImporterStore {
  putHarnessItem(req: HarnessImportRequest): HarnessItem;
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
  /** The `.claude` base the importer read from (absolute); also the origin
   *  prefix the review UI reverts an import by. */
  baseDir: string;
  /** Whether that base existed at all — a clean "nothing to import" signal. */
  baseExists: boolean;
  /** Count of rows that landed, per kind (all disabled by the gate). */
  imported: { command: number; skill: number; subagent: number };
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
  /** Absolute path — becomes provenance.origin (rollback/display handle). */
  origin: string;
  content: string;
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

/** skills/<name>/SKILL.md (canonical) or skills/<name>.md (flat). */
function readSkills(fs: ImporterFs, skillsDir: string): RawArtifact[] {
  const out: RawArtifact[] = [];
  for (const ent of safeReaddir(fs, skillsDir)) {
    if (ent.isDirectory()) {
      const skillFile = path.join(skillsDir, ent.name, 'SKILL.md');
      const content = safeRead(fs, skillFile);
      if (content !== null) out.push({ name: ent.name, origin: skillFile, content });
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
// The import driver.
// ---------------------------------------------------------------------------

export interface ImportClaudeArgs {
  scope: HarnessScope;
  scopeKey: string;
  /** For user scope, the `.claude` under this home dir. Defaults to os.homedir(). */
  homeDir?: string;
  /** For project scope, the project root whose `.claude/` is imported. */
  cwd?: string;
  store: ImporterStore;
  fs?: ImporterFs;
}

/** Resolve the `.claude` base directory for a scope. */
export function resolveBaseDir(args: {
  scope: HarnessScope;
  homeDir?: string;
  cwd?: string;
}): string | null {
  if (args.scope === 'user') {
    return path.join(args.homeDir ?? os.homedir(), '.claude');
  }
  if (args.scope === 'project') {
    return args.cwd ? path.join(args.cwd, '.claude') : null;
  }
  // org scope has no local `.claude` on disk in single-user builds.
  return null;
}

const KIND_ORDER: HarnessKind[] = ['command', 'skill', 'subagent'];

/**
 * Walk a scope's `.claude` base and import every command/skill/subagent through
 * the gate (all land disabled). Hooks are counted and dropped. Returns a full
 * summary for the review UI.
 */
export function importClaudeHarness(args: ImportClaudeArgs): HarnessImportSummary {
  const fs = args.fs ?? (nodeFs as unknown as ImporterFs);
  const baseDir = resolveBaseDir({ scope: args.scope, homeDir: args.homeDir, cwd: args.cwd });

  const summary: HarnessImportSummary = {
    scope: args.scope,
    scopeKey: args.scopeKey,
    baseDir: baseDir ?? '',
    baseExists: false,
    imported: { command: 0, skill: 0, subagent: 0 },
    skippedHooks: 0,
    skipped: [],
    failed: [],
    items: [],
  };

  if (!baseDir || !fs.existsSync(baseDir)) return summary;
  summary.baseExists = true;

  // Hooks: count, then drop. Never read a hook body into the store.
  summary.skippedHooks = countHooks(fs, baseDir);

  const importedAt = Date.now();

  // Gather each kind's raw artifacts + how to parse them.
  const jobs: Array<{
    kind: HarnessKind;
    format: NonNullable<HarnessItem['provenance']['format']>;
    raws: RawArtifact[];
    parse: (name: string, content: string) => ParsedHarness | null;
  }> = [
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
      const req: HarnessImportRequest = {
        item: {
          scope: args.scope,
          scopeKey: args.scopeKey,
          kind: job.kind,
          name: parsed.name,
          ...(parsed.description ? { description: parsed.description } : {}),
          // source:'external' — the gate FORCES this to disabled (contract §4
          // invariant 1). An imported item is inert until reviewed + enabled.
          provenance: {
            source: 'external',
            origin: raw.origin,
            format: job.format,
            importedAt,
          },
          ...(parsed.command ? { command: parsed.command } : {}),
          ...(parsed.skill ? { skill: parsed.skill } : {}),
          ...(parsed.subagent ? { subagent: parsed.subagent } : {}),
        },
        // Ask for enabled; the gate downgrades external to disabled regardless —
        // asserting the import is genuinely inert, not merely defaulted.
        requestedStatus: 'enabled',
      };
      try {
        const item = args.store.putHarnessItem(req);
        summary.items.push(item);
        summary.imported[job.kind] += 1;
      } catch (e) {
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
