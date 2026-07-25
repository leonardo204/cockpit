/**
 * /api/commands — list the slash commands the autocomplete dropdown offers.
 *
 * Two sources are MERGED here (Phase 1.6 HP-02):
 *   1. the in-process builtin set (`/qa`, `/fx`, …) — unchanged, still carrying
 *      their bilingual en/ko expansion in slashCommands' COMMAND_CONTENT;
 *   2. Naby-OWNED commands (kind='command', status='enabled') read from the store
 *      for the `user` scope (always) and the `project` scope (when a `cwd` query
 *      param is supplied). These are the rows the /api/harness CRUD surface
 *      creates.
 *
 * OVERRIDE. An owned command whose verb equals a builtin's REPLACES the builtin
 * in the dropdown (the user's own definition wins) — matching the dispatcher's
 * precedence in slashCommands.resolveCommandPrompt. A project-scope owned command
 * further overrides a user-scope one of the same verb.
 *
 * Each entry MUST have a matching expansion: builtins in COMMAND_CONTENT, owned
 * commands via their stored `command.template` (also read by resolveCommandPrompt).
 * Listing a name here without an expansion makes the dropdown advertise a feature
 * that silently no-ops on dispatch.
 */
import { Effect } from "effect"
import { handler } from "@cockpit/effect-runtime/server"
import {
  DEFAULT_USER_ID,
  canBeAddressed,
  type GrowthStage,
  type HarnessItem,
  type HarnessKind,
  type Store,
} from "../../../../../../../dist/naby-runtime.mjs"
import { getStore } from "../engines/naby"
import { readGrowth } from "../lib/growthRead"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// `source` widens beyond 'builtin' to badge Naby-owned rows in the dropdown.
// 'org' is a team-shared (in-house) command inherited from the org scope (HP-08).
export interface CommandInfo {
  name: string
  description: string
  source: "builtin" | "user" | "org" | "project"
  // Which owned-harness kind this row is (undefined for a builtin). The "/" menu
  // now unifies command/skill/subagent into ONE palette (Claude-Code-style UX):
  // a skill invocation injects its instructions, a subagent injection adopts its
  // persona — both handled in slashCommands.resolveCommandPrompt. MCP is
  // deliberately NOT here: an MCP server is a tool provider, not a prompt.
  kind?: HarnessKind
  argumentHint?: string
  // naby AGENT rows (Phase 3, P3-M5). A different layer from the harness — spec
  // §2: `/` calls tools, `@` calls agents — so these are offered for the `@`
  // marker ONLY, and FIRST, because addressing an agent is the headline action.
  //
  // `addressable` is the trust gate: an agent that has not been verified to the
  // butterfly stage is listed but greyed out. The SAME predicate the engine uses
  // (canBeAddressed), so the palette can never offer what routing would refuse.
  agent?: {
    stage: GrowthStage
    /** progress toward butterfly, 0–100 */
    percent: number
    addressable: boolean
  }
}

// Cross-kind precedence when the same verb exists as more than one kind: a
// command wins over a skill wins over a subagent. Combined with scope precedence
// (project > org > user) into a single rank so the merge is order-independent.
const KIND_RANK: Record<HarnessKind, number> = { command: 3, skill: 2, subagent: 1 }
// Display grouping only (does not affect override precedence): commands first,
// then skills, then subagents.
const KIND_ORDER: Record<HarnessKind, number> = { command: 0, skill: 1, subagent: 2 }

function scopeRank(source: CommandInfo["source"]): number {
  return source === "project" ? 3 : source === "org" ? 2 : source === "user" ? 1 : 0
}

// HP-08: the single in-house org key. Kept in sync with the harness route's
// DEFAULT_ORG_ID so org-scope palette reads and org-scope harness writes address
// the same rows.
const DEFAULT_ORG_ID = "default"

const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "/qa", description: "Enter requirements clarification mode", source: "builtin" },
  { name: "/ap", description: "Enter apply mode: implement <SPEC> while keeping running apply-notes", source: "builtin" },
  { name: "/fx", description: "Enter bug evidence-chain analysis mode", source: "builtin" },
  { name: "/ex", description: "Enter structured analysis & discussion mode", source: "builtin" },
  { name: "/go", description: "Enter landing mode: MVP staged implementation with self-verify", source: "builtin" },
  { name: "/new-branch", description: "Create a clean new branch off the latest origin/main", source: "builtin" },
]

type CommandStore = Pick<Store, "listHarness"> & Partial<AgentPaletteStore>
type AgentPaletteStore = Pick<Store, "listAgents" | "listEvalEvents">

/** Read enabled owned commands for the user scope (always), the org scope
 *  (always — a team-shared set inherited from the in-house org, HP-08), and,
 *  when a cwd is given, the project scope. Order is user → org → project so the
 *  more specific scope wins on a verb clash (a plain map upsert in mergeCommands).
 *  Best-effort: a store hiccup must never break the builtin dropdown, so each
 *  read is guarded and returns [] on failure. */
function loadOwnedCommands(cwd: string | null, store: CommandStore): HarnessItem[] {
  const out: HarnessItem[] = []
  // Load EVERY enabled owned kind (command/skill/subagent) — the "/" palette now
  // unifies all three. One read per scope (kind-agnostic) so a store that filters
  // only on status still returns them all.
  try {
    out.push(...store.listHarness("user", DEFAULT_USER_ID, { status: "enabled" }))
  } catch {
    /* ignore — fall back to builtins only */
  }
  try {
    out.push(...store.listHarness("org", DEFAULT_ORG_ID, { status: "enabled" }))
  } catch {
    /* ignore — org may be empty on a single-user build */
  }
  if (cwd) {
    try {
      out.push(...store.listHarness("project", cwd, { status: "enabled" }))
    } catch {
      /* ignore */
    }
  }
  return out
}

/** Merge builtins with owned commands. Owned verbs OVERRIDE builtins of the same
 *  name; a later (project) owned row overrides an earlier (user) one — the input
 *  order of `owned` is user-first, project-second, so a plain map upsert yields
 *  the right precedence. Builtin order is preserved; new owned verbs append. */
export function mergeCommands(builtins: CommandInfo[], owned: HarnessItem[]): CommandInfo[] {
  const byVerb = new Map<string, CommandInfo>()
  const rankOf = new Map<string, number>()
  const order: string[] = []
  // Rank-guarded upsert: a new row replaces an existing one only when its rank is
  // >= the incumbent's, so precedence (kind × scope) is order-independent and a
  // builtin (rank 0) is always overridden by any owned row of the same verb.
  const upsert = (info: CommandInfo, rank: number) => {
    const verb = info.name.replace(/^\//, "")
    const prev = rankOf.get(verb)
    if (prev === undefined) order.push(verb)
    if (prev === undefined || rank >= prev) {
      byVerb.set(verb, info)
      rankOf.set(verb, rank)
    }
  }
  for (const b of builtins) upsert(b, 0)
  // Sort by kind for display grouping only (command → skill → subagent); the rank
  // guard, not this order, decides who wins a verb clash.
  const sorted = [...owned].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9))
  for (const item of sorted) {
    const payloadOk =
      item.kind === "command"
        ? !!item.command
        : item.kind === "skill"
          ? !!item.skill
          : item.kind === "subagent"
            ? !!item.subagent
            : false
    if (!payloadOk) continue
    const source: CommandInfo["source"] =
      item.scope === "project" ? "project" : item.scope === "org" ? "org" : "user"
    const argumentHint = item.kind === "command" ? item.command?.argumentHint : undefined
    upsert(
      {
        name: `/${item.name}`,
        description: item.description ?? argumentHint ?? "",
        source,
        kind: item.kind,
        ...(argumentHint ? { argumentHint } : {}),
      },
      KIND_RANK[item.kind] * 10 + scopeRank(source),
    )
  }
  return order.map((verb) => byVerb.get(verb)!)
}

/** naby agents as palette rows, each carrying its growth stage.
 *
 *  Best-effort like the harness read: a store hiccup must never empty the
 *  dropdown, so a failure yields [] rather than throwing. The persona comes first
 *  (it is the agent the product is about), then the rest by name.
 */
export function loadAgentEntries(store: AgentPaletteStore): CommandInfo[] {
  let agents
  try {
    agents = store.listAgents()
  } catch {
    return []
  }
  return agents.map((a) => {
    // Shared with the Settings panel (growthRead), so the badge here and the
    // gauge there can never disagree. Best-effort inside: no ledger reads as an
    // egg rather than throwing.
    const g = readGrowth(store, a.id)
    const stage: GrowthStage = g.stage
    const percent = g.percent
    return {
      name: `@${a.name}`,
      description: a.description ?? a.systemPrompt.split("\n")[0]?.slice(0, 120) ?? "",
      source: "user" as const,
      agent: { stage, percent, addressable: canBeAddressed(stage) },
    }
  })
}

export function listCommands(cwd: string | null, store: CommandStore = getStore()): CommandInfo[] {
  // Agents FIRST: `@` is how the product's headline feature is invoked, and the
  // client filters them out for `/`.
  return [
    ...loadAgentEntries(store as AgentPaletteStore),
    ...mergeCommands(BUILTIN_COMMANDS, loadOwnedCommands(cwd, store)),
  ]
}

export const GET = handler((request) =>
  Effect.sync(() => {
    const cwd = new URL(request.url).searchParams.get("cwd")
    return new Response(JSON.stringify(listCommands(cwd)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  })
)
