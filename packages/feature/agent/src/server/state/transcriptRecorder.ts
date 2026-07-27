/**
 * transcriptRecorder — records a NON-Naby engine's turn into the Naby store.
 *
 * WHY. Every session-facing view in this app reads `app.db`: the recent lists
 * (./recentSessions), the session browsers (../api/sessions/nabyBrowse), and
 * the chat transcript itself (../api/session/history). The Naby runtime writes
 * there as it runs, so its sessions are complete. Every other engine wrote its
 * conversation only to its own provider file and left `app.db` untouched — so
 * those sessions did not exist as far as the app was concerned. They were
 * missing from the recent lists, and opening one showed an empty transcript.
 *
 * The fix is NOT to teach the views a second place to look. It is to have every
 * engine land in the one store, which is what this does, from the orchestrator's
 * single `emit` choke point.
 *
 * WHAT IT HANDLES. The engines do not agree on how a reply reaches `emit`, and
 * this is the whole difficulty:
 *   - claude / deepseek send complete `assistant` messages AND partial
 *     `stream_event` deltas AND the full text again in `result.result` — the
 *     same words three times over,
 *   - codex / kimi send only complete `assistant` messages,
 *   - ollama sends ONLY deltas and never an `assistant` text block at all.
 * So the rule is a precedence, not a concatenation: a complete message wins;
 * deltas are used only when no complete message ever arrived; `result.result` is
 * the last resort. Concatenating instead would triple every claude reply.
 *
 * Tool results have a second disagreement: codex and kimi omit the block's
 * `type` field, so a result is recognised by carrying a `tool_use_id`, never by
 * `type === 'tool_result'`.
 *
 * BUFFERED, flushed once at teardown. Not an optimisation — kimi does not know
 * its own session id until the child process closes, so there is no id to write
 * under until the run is over. The live view never depends on this: it streams
 * from the run registry. The cost is that a hard crash mid-run loses the store
 * copy, while the engine's own file keeps it.
 */
import type { RuntimeMessage } from '../engines/naby';
import type { RunEvent } from '../engines/types';

/** The store surface this needs. Narrow so a test can satisfy it. */
export interface TranscriptStore {
  touchSession(sessionId: string, providerId?: string): unknown;
  getSession(sessionId: string): { cwd?: string } | undefined;
  setSessionProject(sessionId: string, cwd: string | null): void;
  appendMessage(sessionId: string, msg: RuntimeMessage): void;
}

export interface TranscriptRecorder {
  /** Feed one engine event. Never throws — a recorder fault must not fail a run. */
  observe(event: RunEvent): void;
  /**
   * Write the turn under `sessionId`. No-op when the id is unknown (the engine
   * never revealed one) or when nothing was captured. Safe to call twice.
   */
  flush(sessionId: string | undefined): void;
}

type Block = Record<string, unknown>;

function blocksOf(event: RunEvent): Block[] {
  const message = event.message as { content?: unknown } | undefined;
  const content = message?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

function textOf(block: Block): string {
  return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
}

/** The text of a `stream_event` delta, or '' when the event is anything else. */
function deltaTextOf(event: RunEvent): string {
  const inner = event.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
  if (inner?.type !== 'content_block_delta') return '';
  if (inner.delta?.type !== 'text_delta') return '';
  return typeof inner.delta.text === 'string' ? inner.delta.text : '';
}

export function createTranscriptRecorder(opts: {
  /**
   * Resolved at FLUSH time, not construction time. Opening the database is a
   * side effect, and a run that never reveals a session id (or never says
   * anything) must not cause one — which is also what keeps a dispatch in a
   * unit test from reaching for the user's real store.
   */
  store: () => TranscriptStore;
  /** Recorded as the session's provider hint; also the engine badge on cards. */
  providerId: string;
  /** Links the session to its project. Empty is allowed — a projectless session. */
  cwd?: string;
  /** The turn's user prompt. Written first, because `emit` never carries it:
   *  the run registry seeds the human bubble directly (sessionRunHub). */
  prompt?: string;
}): TranscriptRecorder {
  const rows: RuntimeMessage[] = [];
  /** Tool name per call id, so a result row can name the tool it answers. */
  const toolNames = new Map<string, string>();
  /** Text seen as complete `assistant` blocks — authoritative when present. */
  let sawCompleteText = false;
  /** Deltas since the last flush point; only used if no complete text arrives. */
  let deltas = '';
  /** The terminal `result.result`, kept as the last-resort text source. */
  let resultText = '';
  let flushed = false;

  /** Turn any buffered deltas into a row. Called before anything that must come
   *  after the text — a tool call, or the end of the turn. */
  function settleDeltas(): void {
    if (sawCompleteText) {
      deltas = '';
      return;
    }
    const text = deltas.trim();
    deltas = '';
    if (text) rows.push({ role: 'assistant', content: text });
  }

  function observeUnsafe(event: RunEvent): void {
    switch (event.type) {
      case 'assistant': {
        const blocks = blocksOf(event);
        const text = blocks.map(textOf).join('');
        const calls = blocks.filter((b) => b.type === 'tool_use');

        if (text.trim()) {
          // A complete message supersedes whatever partial deltas built it.
          sawCompleteText = true;
          deltas = '';
          rows.push({ role: 'assistant', content: text });
        }
        for (const call of calls) {
          const id = typeof call.id === 'string' ? call.id : '';
          const name = typeof call.name === 'string' ? call.name : 'tool';
          if (!id) continue;
          settleDeltas();
          toolNames.set(id, name);
          // One assistant row per call, matching the runtime's own pairing: the
          // history view joins a result to its call by id and drops any orphan.
          rows.push({
            role: 'assistant',
            content: '',
            toolCalls: [{ toolCallId: id, toolName: name, input: call.input }],
          });
        }
        return;
      }

      case 'user': {
        // On the engine side a `user` event is always a tool result — the human
        // prompt never passes through emit.
        for (const block of blocksOf(event)) {
          const id = block.tool_use_id;
          if (typeof id !== 'string' || !id) continue;
          const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
          rows.push({
            role: 'tool',
            toolCallId: id,
            toolName: toolNames.get(id) ?? 'tool',
            output: { content, ...(block.is_error === true ? { isError: true } : {}) },
          });
        }
        return;
      }

      case 'stream_event': {
        if (sawCompleteText) return; // the complete messages already have it
        deltas += deltaTextOf(event);
        return;
      }

      case 'result': {
        if (typeof event.result === 'string') resultText = event.result;
        return;
      }

      default:
        // system/init, harness, approvals, thinking, errors — live-view concerns
        // with no place in a transcript.
        return;
    }
  }

  return {
    observe(event: RunEvent): void {
      try {
        observeUnsafe(event);
      } catch {
        // A malformed event costs one row, never the run.
      }
    },

    flush(sessionId: string | undefined): void {
      if (flushed || !sessionId) return;
      flushed = true;

      settleDeltas();
      // Last resort: engines that only report their reply in the terminal event
      // (and any turn whose text never arrived any other way).
      if (!rows.some((r) => r.role === 'assistant' && r.content.trim()) && resultText.trim()) {
        rows.push({ role: 'assistant', content: resultText });
      }

      const userText = opts.prompt?.trim();
      if (!userText && rows.length === 0) return;

      try {
        const store = opts.store();
        // Creates the session if this id is new to the store, and records which
        // engine answered (the browsers render it as the session's badge).
        store.touchSession(sessionId, opts.providerId);
        // The project link is FILLED IN, never rewritten: a session already
        // linked keeps that link, because moving a session between projects is a
        // deliberate act and not a side effect of a turn running elsewhere.
        if (opts.cwd && !store.getSession(sessionId)?.cwd) {
          store.setSessionProject(sessionId, opts.cwd);
        }
        if (userText) store.appendMessage(sessionId, { role: 'user', content: userText });
        for (const row of rows) store.appendMessage(sessionId, row);
      } catch {
        // The engine's own file still holds the conversation; losing the store
        // copy must not turn a finished run into a failed one.
      }
    },
  };
}
