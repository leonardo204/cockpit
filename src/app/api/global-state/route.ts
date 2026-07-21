/**
 * /api/global-state route shim.
 *
 * GET is re-exported verbatim from the feature package. POST (mark read /
 * rename) and DELETE (clear recents) are wrapped so that AFTER the store write
 * they push a fresh recent-sessions snapshot to every /ws/global-state client.
 *
 * WHY THE WRAP: the sidebar badge/dropdown refreshes on an fs.watch of
 * state.json (see globalStateHandler.ts). Since Phase C-2 these writes land in
 * the Naby store, not state.json, so no watch event fires — which is exactly why
 * the unread badge never cleared after viewing a session. Broadcasting the
 * snapshot here re-pushes the store-derived status so the badge decrements
 * immediately, without reintroducing a state.json status write.
 */
import {
  GET,
  POST as featurePost,
  DELETE as featureDelete,
  runtime,
  dynamic,
} from "@cockpit/feature-agent/server/api/global-state"
import { getGlobalSessionsSnapshot } from "@cockpit/feature-agent/server/state/globalState"
import { broadcastToGlobalState } from "../../../lib/globalStateBroadcast"

export { GET, runtime, dynamic }

/** Push the store-derived recent-sessions snapshot to all sidebar clients. */
async function pushSidebarSnapshot(): Promise<void> {
  try {
    const sessions = await getGlobalSessionsSnapshot()
    broadcastToGlobalState({ type: "global-state", data: { sessions } })
  } catch {
    /* best-effort — a failed push never fails the originating request */
  }
}

export async function POST(req: Request): Promise<Response> {
  const res = await featurePost(req)
  await pushSidebarSnapshot()
  return res
}

export async function DELETE(req: Request): Promise<Response> {
  const res = await featureDelete(req)
  await pushSidebarSnapshot()
  return res
}
