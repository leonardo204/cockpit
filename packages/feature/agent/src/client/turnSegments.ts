import type { ToolCallInfo } from './types';
import type { SubagentGroup, SubagentPartition } from './subagentGroups';
import type { BackgroundJob } from './backgroundJobs';
import {
  type TurnSegment,
  appendTextSegment,
  appendToolCallSegment,
  nextSegmentId,
  segmentedCallIds,
} from '../shared/turnSegments';

export type { TurnSegment };
export { appendTextSegment, appendToolCallSegment, nextSegmentId, segmentedCallIds };

/**
 * THE RENDER SIDE of the segment model (the ordered core is in
 * `shared/turnSegments.ts`, shared with the reload mapper).
 *
 * Turns the stored skeleton — text runs and lists of tool call IDS — into the
 * things the view actually draws, resolving ids against the turn's calls and
 * placing each delegated run's block at the point it was SPAWNED rather than at
 * the end of the turn.
 */
export type RenderSegment =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tools'; id: string; calls: ToolCallInfo[] }
  | { kind: 'subagent'; id: string; group: SubagentGroup }
  | { kind: 'background'; id: string; job: BackgroundJob };

/**
 * Build the ordered list a turn renders as.
 *
 * `partition` is what `groupSubagentCalls` already worked out: the main
 * thread's calls (`topLevel`) and one block per delegated run (`groups`). This
 * function does not re-decide any of that — it only places it in time.
 *
 * WHERE A SUBAGENT BLOCK GOES. At the position of the `Task` call that spawned
 * it, because that is when the delegation happened and the reader is looking
 * for it exactly there. `groupSubagentCalls` has already folded that call out of
 * the batch and onto the group as `parentCall`, so the anchor is its id. A run
 * whose spawning call cannot be identified (an older transcript, or a backend
 * that reported the agent but not the call) is anchored at its FIRST OWN call
 * instead — still the right region of the turn, never a guess about which Task
 * it was. A run with neither is appended at the end, where the old flat view put
 * every one of them.
 *
 * OLD TRANSCRIPTS RENDER AS THEY ALWAYS DID. When `segments` is missing or empty
 * — every turn recorded before this existed, and any producer that does not
 * build them — there is no ordering information to recover, and none is
 * invented: the turn comes back as one text bubble, then one batch, then the
 * blocks. That is exactly the old layout, which is the honest answer for data
 * that never recorded where the splits were.
 */
export function buildRenderSegments(
  segments: readonly TurnSegment[] | undefined,
  content: string,
  partition: SubagentPartition,
  /** The turn's BACKGROUND JOBS (backgroundJobs.ts), anchored by the same rule
   *  as a delegated run: at the call that launched them. Optional so every
   *  existing caller — and every turn that backgrounded nothing — is unchanged. */
  backgroundJobs?: readonly BackgroundJob[]
): RenderSegment[] {
  const { topLevel, groups } = partition;
  const jobs = backgroundJobs ?? [];
  const out: RenderSegment[] = [];

  if (!segments || segments.length === 0) {
    if (content) out.push({ kind: 'text', id: 's0', text: content });
    if (topLevel.length > 0) out.push({ kind: 'tools', id: 'legacy-tools', calls: topLevel });
    for (const group of groups) {
      out.push({ kind: 'subagent', id: `agent-${group.id}`, group });
    }
    for (const job of jobs) {
      out.push({ kind: 'background', id: `bg-${job.id}`, job });
    }
    return out;
  }

  const callById = new Map<string, ToolCallInfo>();
  for (const call of topLevel) callById.set(call.id, call);

  // Anchors: the spawning `Task` call first, the run's own first call as the
  // fallback. Both are ids that appear in the segment list, so a group is
  // emitted the moment the turn reaches the point it started at.
  const anchorToGroup = new Map<string, SubagentGroup>();
  for (const group of groups) {
    const anchor = group.parentCall?.id ?? group.calls[0]?.id;
    if (anchor && !anchorToGroup.has(anchor)) anchorToGroup.set(anchor, group);
  }
  // A BACKGROUND JOB SITS WHERE IT WAS LAUNCHED, for the same reason a delegated
  // run does: that is the moment it happened and where the reader is looking.
  // Its spawning call has already been folded out of the batch, so the anchor is
  // that call's id — the block takes the row's place rather than adding one
  // beside it. A job with no spawning call in this batch (launched inside a
  // subagent) has no anchor and is appended below, never guessed at.
  const anchorToJob = new Map<string, BackgroundJob>();
  for (const job of jobs) {
    const anchor = job.spawningCall?.id;
    if (anchor && !anchorToJob.has(anchor)) anchorToJob.set(anchor, job);
  }
  const emitted = new Set<string>();
  const emittedJobs = new Set<string>();

  for (const seg of segments) {
    if (seg.kind === 'text') {
      if (seg.text) out.push({ kind: 'text', id: seg.id, text: seg.text });
      continue;
    }
    // A tools segment can be interrupted by a subagent block sitting at the
    // position of its spawning call, so it may emit more than one row. The
    // extra rows get suffixed ids — still stable, still derived from the
    // segment that produced them.
    let batch: ToolCallInfo[] = [];
    let part = 0;
    const flush = () => {
      if (batch.length === 0) return;
      out.push({
        kind: 'tools',
        id: part === 0 ? seg.id : `${seg.id}-${part}`,
        calls: batch,
      });
      part += 1;
      batch = [];
    };
    for (const callId of seg.callIds) {
      const group = anchorToGroup.get(callId);
      if (group && !emitted.has(group.id)) {
        flush();
        emitted.add(group.id);
        out.push({ kind: 'subagent', id: `${seg.id}-agent-${group.id}`, group });
        continue;
      }
      const job = anchorToJob.get(callId);
      if (job && !emittedJobs.has(job.id)) {
        flush();
        emittedJobs.add(job.id);
        out.push({ kind: 'background', id: `${seg.id}-bg-${job.id}`, job });
        continue;
      }
      // Missing from `topLevel` means the call is a subagent's own work (folded
      // into its block) or filtered from display (ExitPlanMode). Either way it
      // is not a row of this batch.
      const call = callById.get(callId);
      if (call) batch.push(call);
    }
    flush();
  }

  // Anything the segments did not account for. Neither case should arise from
  // the two builders, but a turn must not silently LOSE a call or a block just
  // because its skeleton was incomplete.
  const placed = new Set(segmentedCallIds(segments));
  const orphans = topLevel.filter((c) => !placed.has(c.id));
  if (orphans.length > 0) out.push({ kind: 'tools', id: 'unsegmented-tools', calls: orphans });
  for (const group of groups) {
    if (!emitted.has(group.id)) out.push({ kind: 'subagent', id: `agent-${group.id}`, group });
  }
  for (const job of jobs) {
    if (!emittedJobs.has(job.id)) out.push({ kind: 'background', id: `bg-${job.id}`, job });
  }

  return out;
}

/** The id of the LAST text segment in a rendered turn — where the turn's
 *  per-turn message actions (copy) hang, and the only place a streaming caret
 *  may appear. `null` when the turn said nothing. */
export function lastTextSegmentId(rendered: readonly RenderSegment[]): string | null {
  for (let i = rendered.length - 1; i >= 0; i -= 1) {
    const seg = rendered[i]!;
    if (seg.kind === 'text') return seg.id;
  }
  return null;
}
