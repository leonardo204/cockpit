/**
 * /api/global-state route shim.
 *
 * GET is re-exported verbatim from the feature package. POST (mark read /
 * rename) and DELETE (clear recents) are wrapped so that AFTER the store write
 * they push a fresh recent-sessions snapshot to every /ws/global-state client.
 *
 * WHY THE WRAP, now that the sidebar watches the store these writes land in
 * (globalStateHandler.ts): latency, not correctness. The watcher debounces, so
 * the badge would decrement a fraction of a second after the click; pushing
 * here makes it decrement with it. If this wrapper were deleted the badge would
 * still clear — which is the point of watching the file you read.
 */
import {
  GET,
  POST as featurePost,
  DELETE as featureDelete,
  runtime,
  dynamic,
} from "@cockpit/feature-agent/server/api/global-state"
import {
  getGlobalSessionsSnapshot,
  getPendingOrgUpdateSnapshot,
} from "@cockpit/feature-agent/server/state/globalState"
import { broadcastToGlobalState } from "../../../lib/globalStateBroadcast"

export { GET, runtime, dynamic }

/** Push the store-derived recent-sessions snapshot to all sidebar clients. */
async function pushSidebarSnapshot(): Promise<void> {
  try {
    const sessions = await getGlobalSessionsSnapshot()
    // Same envelope as the watcher's push (globalStateHandler.ts), so a client
    // never reads a missing `orgUpdate` as "the popup was dismissed".
    const orgUpdate = getPendingOrgUpdateSnapshot()
    broadcastToGlobalState({ type: "global-state", data: { sessions, orgUpdate } })
  } catch {
    /* best-effort — a failed push never fails the originating request */
  }
}

/**
 * The project whose session tree a rename changed, or null. A rename is a POST
 * carrying `title` (empty = back to the automatic title); mark-read carries
 * none. The recent-sessions snapshot above does not reach the project tree in
 * the sidebar, which refetches a branch only on `project-state-changed` — so a
 * renamed tab kept its old name there until something else touched the project.
 */
async function renamedCwd(req: Request): Promise<string | null> {
  try {
    const body = (await req.clone().json()) as { cwd?: unknown; title?: unknown }
    return typeof body.title === "string" && typeof body.cwd === "string" && body.cwd ? body.cwd : null
  } catch {
    return null
  }
}

export async function POST(req: Request): Promise<Response> {
  const cwd = await renamedCwd(req)
  const res = await featurePost(req)
  await pushSidebarSnapshot()
  if (cwd && res.ok) {
    // Nothing closed — the tree just refetches the branch and picks up the name.
    broadcastToGlobalState({ type: "project-state-changed", cwd, closedSessionIds: [] })
  }
  return res
}

export async function DELETE(req: Request): Promise<Response> {
  const res = await featureDelete(req)
  await pushSidebarSnapshot()
  return res
}
