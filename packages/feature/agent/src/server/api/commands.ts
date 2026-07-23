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
  type HarnessItem,
  type Store,
} from "../../../../../../../dist/naby-runtime.mjs"
import { getStore } from "../engines/naby"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// `source` widens beyond 'builtin' to badge Naby-owned rows in the dropdown.
export interface CommandInfo {
  name: string
  description: string
  source: "builtin" | "user" | "project"
  argumentHint?: string
}

const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "/qa", description: "Enter requirements clarification mode", source: "builtin" },
  { name: "/ap", description: "Enter apply mode: implement <SPEC> while keeping running apply-notes", source: "builtin" },
  { name: "/fx", description: "Enter bug evidence-chain analysis mode", source: "builtin" },
  { name: "/ex", description: "Enter structured analysis & discussion mode", source: "builtin" },
  { name: "/go", description: "Enter landing mode: MVP staged implementation with self-verify", source: "builtin" },
  { name: "/new-branch", description: "Create a clean new branch off the latest origin/main", source: "builtin" },
]

type CommandStore = Pick<Store, "listHarness">

/** Read enabled owned commands for the user scope (always) and, when a cwd is
 *  given, the project scope. Best-effort: a store hiccup must never break the
 *  builtin dropdown, so each read is guarded and returns [] on failure. */
function loadOwnedCommands(cwd: string | null, store: CommandStore): HarnessItem[] {
  const out: HarnessItem[] = []
  try {
    out.push(...store.listHarness("user", DEFAULT_USER_ID, { kind: "command", status: "enabled" }))
  } catch {
    /* ignore — fall back to builtins only */
  }
  if (cwd) {
    try {
      out.push(...store.listHarness("project", cwd, { kind: "command", status: "enabled" }))
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
  const order: string[] = []
  const upsert = (info: CommandInfo) => {
    const verb = info.name.replace(/^\//, "")
    if (!byVerb.has(verb)) order.push(verb)
    byVerb.set(verb, info)
  }
  for (const b of builtins) upsert(b)
  for (const item of owned) {
    if (item.kind !== "command" || !item.command) continue
    upsert({
      name: `/${item.name}`,
      description: item.description ?? item.command.argumentHint ?? "",
      source: item.scope === "project" ? "project" : "user",
      ...(item.command.argumentHint ? { argumentHint: item.command.argumentHint } : {}),
    })
  }
  return order.map((verb) => byVerb.get(verb)!)
}

export function listCommands(cwd: string | null, store: CommandStore = getStore()): CommandInfo[] {
  return mergeCommands(BUILTIN_COMMANDS, loadOwnedCommands(cwd, store))
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
