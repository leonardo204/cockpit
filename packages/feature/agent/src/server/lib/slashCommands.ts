// slashCommands — expansion for `/verb` and `@verb` lines.
//
// EVERY VERB COMES FROM THE HARNESS. The commands, skills and subagents the user
// registered under Settings > Harness live in `app.db` and are the only thing a
// `/` line can name. The cockpit builtins that used to live here (`/qa`, `/ap`,
// `/fx`, `/ex`, `/go`, `/new-branch`) are gone, along with the machinery that
// backed them: their bilingual prompt bodies, the SKILL.md files they wrote into
// `~/.cockpit/skills/`, and the `~/.cockpit/skills.json` registry read — which
// nothing had written since the tool that produced it was removed in the F1-03
// trim, so it could only ever have resolved a file the app no longer creates.
//
// The point is that ONE list answers "what can I type": the palette
// (`api/commands.ts`) and this resolver read the same harness rows, so a verb the
// menu offers always expands and a verb it does not offer never silently does.
import {
  DEFAULT_USER_ID,
  type HarnessItem,
  type HarnessKind,
  type Store,
} from '../../../../../../../dist/naby-runtime.mjs';
import { getStore } from '../engines/naby';

// A single parsed command step: its marker, verb, and the body text that
// belongs to it (everything up to the next command line).
type StepMarker = '/' | '@';
interface ParsedStep {
  marker: StepMarker;
  cmd: string;
  body: string;
}

// One command line: `/verb …` or `@verb …` at the start of a line (leading
// whitespace allowed). Verb starts with a letter, then letters/digits/hyphens
// (/qa, /new-branch, /c4). Char class is kept in sync with the client
// autocomplete (ChatInput's commandQuery).
const COMMAND_LINE_RE = /^\s*([/@])([a-zA-Z][a-zA-Z0-9-]*)(?:\s+|$)/;

// Resolves slash/at commands before the prompt is sent to the model. Supports:
//   - multiple commands, one per line — each line starting with `/verb` or
//     `@verb` begins a step; its body runs until the next command line
//     (multi-line + blank lines included).
//   - `/verb` runs in the main session; `@verb` is delegated to a subagent.
//   - the verb is a harness row (command / skill / subagent) and nothing else.
//
// Each verb resolves to its stored body, inlined. There is no SKILL.md written
// to disk and read back any more: that indirection existed for the builtins,
// whose bodies lived in code and had to be materialised as files first.
//
// A single `/verb` (no preamble, no `@`) keeps the compact "body + trailing
// text" output. Two+ verbs, or any `@`, or leading preamble text, switch to a
// numbered step list framed for sequential dispatch.
//
/** The store slice command expansion reads — an injectable seam (default
 *  `getStore()`) so tests can drive owned-command override without a sqlite file. */
export type CommandExpansionStore = Pick<Store, 'listHarness' | 'getAgentByName'>;

/** The in-house org scopeKey — kept in sync with commands.ts / harness.ts so the
 *  palette listing and the dispatcher expand the SAME org rows (HP-08). */
const DEFAULT_ORG_ID = 'default';

/**
 * Load enabled Naby-OWNED harness items (Phase 1.6) for the user scope (always),
 * the org scope (always — team-shared HP-08), and, when a cwd is supplied, the
 * project scope. ALL kinds (command/skill/subagent) are loaded: the "/" palette
 * unifies them, so the dispatcher must be able to expand each. Returned
 * user→org→project so a later, more-specific scope wins a verb clash. Best-effort:
 * a store hiccup must never break the builtin dispatcher, so each read is guarded.
 */
function loadOwnedCommands(cwd: string | undefined, store: CommandExpansionStore): HarnessItem[] {
  const out: HarnessItem[] = [];
  try {
    out.push(...store.listHarness('user', DEFAULT_USER_ID, { status: 'enabled' }));
  } catch {
    /* ignore — builtins still work */
  }
  try {
    out.push(...store.listHarness('org', DEFAULT_ORG_ID, { status: 'enabled' }));
  } catch {
    /* ignore — org may be empty on a single-user build */
  }
  if (cwd) {
    try {
      out.push(...store.listHarness('project', cwd, { status: 'enabled' }));
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** One resolved owned entry: which kind it is and the raw body to expand
 *  (command template | skill instructions | subagent system prompt). */
interface OwnedEntry {
  kind: HarnessKind;
  body: string;
}

// Cross-kind precedence (command > skill > subagent) × scope precedence
// (project > org > user), folded into one rank so the map build is
// order-independent — mirrors commands.ts.mergeCommands.
const OWNED_KIND_RANK: Record<HarnessKind, number> = { command: 3, skill: 2, subagent: 1 };
function ownedScopeRank(scope: HarnessItem['scope']): number {
  return scope === 'project' ? 3 : scope === 'org' ? 2 : 1;
}

/** Pull the kind-appropriate expansion body from an owned item, or null when its
 *  payload is missing (a malformed row must not shadow a builtin). */
function ownedBody(item: HarnessItem): string | null {
  if (item.kind === 'command') return item.command?.template ?? null;
  if (item.kind === 'skill') return item.skill?.instructions ?? null;
  if (item.kind === 'subagent') return item.subagent?.systemPrompt ?? null;
  return null;
}

/** verb → resolved owned entry, higher-rank kind/scope winning a clash. */
function ownedCommandMap(items: HarnessItem[]): Map<string, OwnedEntry> {
  const map = new Map<string, OwnedEntry>();
  const rankOf = new Map<string, number>();
  for (const item of items) {
    const body = ownedBody(item);
    if (body === null) continue;
    const rank = OWNED_KIND_RANK[item.kind] * 10 + ownedScopeRank(item.scope);
    const prev = rankOf.get(item.name);
    if (prev === undefined || rank >= prev) {
      map.set(item.name, { kind: item.kind, body });
      rankOf.set(item.name, rank);
    }
  }
  return map;
}

// `{{BASE_URL}}` placeholders are substituted at WRITE time with the loopback
// base URL (http://localhost:<port>) — /cg's curl recipes are executed by the
// agent on the server host, so loopback is always reachable and never needs a
// token.
//
// `cwd` scopes which owned commands participate (user-scope always + that
// project's project-scope commands). Owned commands OVERRIDE a builtin of the
// same verb (Phase 1.6 HP-02). `store` is injectable for tests.
export function resolveCommandPrompt(
  prompt: string,
  language = 'en',
  cwd?: string,
  store: CommandExpansionStore = getStore(),
): string {
  const lang: 'ko' | 'en' = language.startsWith('ko') ? 'ko' : 'en';

  // The harness, read once per dispatch (not per keystroke), so command-line
  // recognition can tell a registered verb from ordinary text-with-a-slash.
  const owned = ownedCommandMap(loadOwnedCommands(cwd, store));
  const isKnown = (cmd: string) => owned.has(cmd);

  // ── Parse: find known command lines, split bodies between them ──
  const lines = prompt.split('\n');
  const marks: Array<{ i: number; marker: StepMarker; cmd: string; rest: string }> = [];
  lines.forEach((line, i) => {
    const m = line.match(COMMAND_LINE_RE);
    if (!m || !isKnown(m[2])) return;
    // Phase 3 P3-M2 collision rule: a registered naby agent name wins over a
    // harness subagent of the same verb. Leave an `@<registeredAgent>` line
    // UNEXPANDED so it flows through to the engine, which routes the turn to that
    // agent (parseAgentAddress). `/verb` is unaffected — only the `@` marker
    // addresses an agent.
    if (m[1] === '@' && store.getAgentByName(m[2])) return;
    marks.push({ i, marker: m[1] as StepMarker, cmd: m[2], rest: line.slice(m[0].length) });
  });
  if (marks.length === 0) return prompt;

  const preamble = lines.slice(0, marks[0].i).join('\n').trim();
  const steps: ParsedStep[] = marks.map((mk, idx) => {
    const end = idx + 1 < marks.length ? marks[idx + 1].i : lines.length;
    const body = [mk.rest, ...lines.slice(mk.i + 1, end)].join('\n').trim();
    return { marker: mk.marker, cmd: mk.cmd, body };
  });

  const resolved = steps.map((s) => resolveStep(s, lang, owned));

  // ── Single `/command`, no preamble → compact output ──
  if (resolved.length === 1 && resolved[0].marker === '/' && !preamble) {
    const r = resolved[0];
    return r.body ? `${r.pointer}\n\n${r.body}` : r.pointer;
  }

  // ── Otherwise: numbered, locus-annotated step list ──
  const intro = lang === 'ko' ? '다음 단계를 순서대로 완료하세요:' : 'Complete the following steps in order:';
  const blocks = resolved.map((r, idx) => {
    const where = stepHeader(idx + 1, r.marker, lang);
    const bodyPart = r.body ? `\n${r.body}` : '';
    return `${where}\n${r.pointer}${bodyPart}`;
  });
  const parts: string[] = [];
  if (preamble) parts.push(preamble);
  parts.push(intro, blocks.join('\n\n'));
  return parts.join('\n\n');
}

interface ResolvedStep {
  marker: StepMarker;
  body: string;
  /** The prompt text this step injects. */
  pointer: string;
}

// Resolve one parsed step. Callers only pass verbs `isKnown` accepted, and the
// only thing it accepts is a harness row, so the lookup cannot miss.
function resolveStep(
  step: ParsedStep,
  lang: 'ko' | 'en',
  owned: Map<string, OwnedEntry>,
): ResolvedStep {
  // The stored body IS the prompt text, so it is inlined directly — no SKILL.md
  // file to write and read back. Expansion happens here, above the engine seam,
  // so a verb behaves identically on every provider.
  //   - command : the template IS the prompt body → inline as-is.
  //   - skill   : the SKILL instructions are directives → inline as-is (an
  //               explicit "/" invocation activates the skill now, on top of the
  //               automatic trigger-based injection the runtime already does).
  //   - subagent: real subagent orchestration is Phase 2.5; until then a "/"
  //               invocation makes the MAIN session adopt the persona by framing
  //               its systemPrompt as a persona directive for this conversation.
  const entry = owned.get(step.cmd)!;
  const pointer = entry.kind === 'subagent' ? framePersona(entry.body, lang) : entry.body;
  return { marker: step.marker, body: step.body, pointer };
}

/** Frame a subagent's system prompt as a persona directive for the MAIN session.
 *  Real subagent orchestration is Phase 2.5; until then, invoking `/persona`
 *  makes the current session adopt the persona for this conversation — a real
 *  behavior change, never a silent no-op. */
function framePersona(systemPrompt: string, lang: 'ko' | 'en'): string {
  return lang === 'ko'
    ? `다음 페르소나로 이번 대화에 응답하세요:\n\n${systemPrompt}`
    : `Adopt the following persona for this conversation:\n\n${systemPrompt}`;
}

/** Step header with execution-locus annotation (main session vs subagent). */
function stepHeader(n: number, marker: StepMarker, lang: 'ko' | 'en'): string {
  if (lang === 'ko') {
    return marker === '@'
      ? `단계 ${n} (subagent로 실행): `
      : `단계 ${n} (메인 세션에서 실행): `;
  }
  return marker === '@'
    ? `Step ${n} (run in a subagent): `
    : `Step ${n} (run in the main session): `;
}
