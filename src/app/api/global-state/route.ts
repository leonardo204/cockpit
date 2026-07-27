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
