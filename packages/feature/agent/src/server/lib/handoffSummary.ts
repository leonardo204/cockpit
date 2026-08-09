// packages/feature/agent/src/server/lib/handoffSummary.ts
//
// THE HANDOFF SUMMARY'S MODEL CALL (specs/session-context-management.md §2.2).
//
// Split from lib/sessionHandoff.ts on purpose: everything there is pure or store-
// only and can be tested with a fake, and everything that could reach a MODEL is
// here, behind one function. That is also what lets a test of the API action stub
// this module and be certain no test on a developer's signed-in laptop makes a
// real call.
//
// IT DRIVES THE ENGINE DIRECTLY, NOT `runTurn` — the same choice, for the same
// reason, as the reflection judge (lib/reflection.ts): `runTurn` would append this
// prompt and its answer to a real transcript and file a usage row against the
// user's conversation. The user asked to continue in a new tab; they did not ask
// for "summarize this" to appear in the conversation they are leaving. So the
// engine is driven directly and BOTH sessions stay clean.
//
// The backend is picked by `resolveJudgeBackend`, imported rather than re-derived:
// a second copy of "which backend can answer here" is how one feature ends up
// believing a sign-in the other cannot see.

import type { RuntimeMessage } from '../../../../../../../dist/naby-runtime.mjs';
import type { HandoffSummarizer } from './sessionHandoff';

/** A handoff is a background convenience, not the turn the user is waiting on, so
 *  it is time-boxed rather than allowed to hang the click that started it. */
export const HANDOFF_SUMMARY_TIMEOUT_MS = 60_000;

export const HANDOFF_SUMMARY_SYSTEM = [
  'You write a HANDOFF between two sittings of the same conversation.',
  'The next sitting starts with an empty transcript but keeps everything the agent',
  'has learned about the user in general, so do NOT restate general facts about them.',
  'Capture only what was true inside THIS conversation:',
  '  - decisions that were agreed (and anything explicitly ruled out),',
  '  - work in progress and exactly where it stands,',
  '  - open questions and what is waiting on whom,',
  '  - names, paths, ids and numbers the next turn will need,',
  // THE WORKING ENVIRONMENT, not just the work. A continuation that knows what was
  // decided but not WHERE it was being done reaches for a different branch, a
  // different service or a different file than the sitting it continues — and the
  // user has to say all of it again, which is exactly what the handoff is for.
  '  - the tools, services, files and branches actively in use (so the next sitting',
  '    reaches for the same ones).',
  "Preserve the conversation's language. Be dense and specific; no preamble, no",
  'closing remark, no offer to help — output the handoff text and nothing else.',
].join('\n');

/** Render the source slice as the user half of the call. Same shape as the
 *  reflection judge's context block: a labelled, flat rendering that cannot be
 *  mistaken for an instruction. */
export function buildHandoffPrompt(messages: readonly RuntimeMessage[]): string {
  const lines: string[] = ['Conversation to hand off:'];
  for (const m of messages) {
    if (m.role === 'tool') {
      lines.push(`Tool ${m.toolName}${m.output.isError ? ' (failed)' : ''}: ${m.output.content}`);
    } else if (m.role === 'assistant') {
      const calls = m.toolCalls?.length
        ? ` [called: ${m.toolCalls.map((c) => c.toolName).join(', ')}]`
        : '';
      lines.push(`Assistant: ${m.content}${calls}`);
    } else {
      lines.push(`User: ${m.content}`);
    }
  }
  return lines.join('\n');
}

/**
 * The production summarizer.
 *
 * NEVER THROWS FOR AN ORDINARY FAILURE. No configured provider, no local sign-in,
 * a timeout, a provider error: all of them return '' and the caller opens the tab
 * without a handoff. A failure here must cost the user a paragraph, never the
 * thing they actually clicked.
 *
 * The engine modules are imported INSIDE the call, exactly as `kickoffDispatch`
 * does it: /api/naby is imported by every settings request, and a static import
 * would drag the engine composition root into requests that only wanted to read a
 * checkbox.
 */
export function modelHandoffSummarizer(): HandoffSummarizer {
  return async ({ messages, signal }) => {
    if (messages.length === 0) return '';
    const { resolveJudgeBackend } = await import('./reflection');
    const backend = await resolveJudgeBackend();
    if (!backend) {
      console.warn('[handoff] no backend can write a handoff summary (no API key, no Claude sign-in)');
      return '';
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), HANDOFF_SUMMARY_TIMEOUT_MS);
    let answer = '';
    try {
      for await (const event of backend.engine.run({
        model: backend.model,
        messages: [{ role: 'user', content: buildHandoffPrompt(messages) }],
        system: HANDOFF_SUMMARY_SYSTEM,
        toolSchemas: [],
        // No tools, and a gate that denies everything — the belt-and-braces half
        // of that. It matters more on the Agent SDK backend, whose built-ins are
        // live unless something stops them.
        gate: async () => ({
          behavior: 'deny' as const,
          reason: 'the handoff summarizer runs without tools',
        }),
        executors: {},
        signal: controller.signal,
      })) {
        if (event.kind === 'text' && event.role === 'assistant' && !event.partial) {
          answer += event.text;
        }
      }
    } catch (e) {
      console.warn(
        `[handoff] summary call failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return '';
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    return answer;
  };
}
