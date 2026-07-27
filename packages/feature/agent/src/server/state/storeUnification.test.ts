import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTranscriptRecorder } from './transcriptRecorder';
import type { TranscriptStore } from './transcriptRecorder';
import { buildRecentSessions } from './recentSessions';
import type { RecentSessionsStore } from './recentSessions';
import { SqliteStore } from '../../../../../../../dist/naby-runtime.mjs';

/**
 * The end of the story these modules exist for: a run on an engine that is NOT
 * Naby has to end up in the same database, and therefore in the same views, as
 * a Naby one. Before this, only the Naby runtime wrote to `app.db`, so a codex
 * or ollama session was invisible — absent from the recent lists and empty when
 * opened — and the tempting fix was to teach the views a second place to look.
 *
 * This runs against a REAL SqliteStore rather than a fake, because the claim is
 * about the database: the recorder's writes and the views' reads have to line up
 * through actual SQL, not through a shared mock.
 */

const dir = mkdtempSync(join(tmpdir(), 'naby-store-unification-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('one store — an engine that is not Naby still lands in the views', () => {
  it('records a codex turn that the recent list then shows, with its project and engine', () => {
    const store = new SqliteStore({ path: join(dir, 'one.db') });

    const rec = createTranscriptRecorder({
      store: () => store as unknown as TranscriptStore,
      providerId: 'codex',
      cwd: '/work/demo',
      prompt: 'list the files',
    });

    // A codex-shaped turn: a tool call, a result block with no `type`, then the
    // reply as a complete assistant message.
    rec.observe({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
    });
    rec.observe({
      type: 'user',
      message: { content: [{ tool_use_id: 't1', content: 'a.txt\nb.txt' }] },
    });
    rec.observe({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'There are two files.' }] },
    });
    rec.observe({ type: 'result', subtype: 'success', usage: {} });
    rec.flush('codex-session-1');

    // The session now exists in the store the views read.
    const recent = buildRecentSessions(undefined, store as unknown as RecentSessionsStore);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      sessionId: 'codex-session-1',
      cwd: '/work/demo',
      engine: 'codex',
      status: 'normal',
    });
    // Title and preview are derived from the user's own words, as for any session.
    expect(recent[0]!.title).toBe('list the files');
    expect(recent[0]!.lastUserMessage).toBe('list the files');

    // And the transcript is complete and correctly paired, so opening it renders
    // the conversation rather than an empty view.
    const messages = store.getMessages('codex-session-1');
    expect(messages.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    const call = messages[1] as { toolCalls?: Array<{ toolCallId: string }> };
    const result = messages[2] as { toolCallId: string };
    expect(call.toolCalls?.[0]?.toolCallId).toBe(result.toolCallId);
    expect((messages[3] as { content: string }).content).toBe('There are two files.');

    store.close();
  });

  it('puts a Naby session and a codex session in one list, ordered by recency', () => {
    const store = new SqliteStore({ path: join(dir, 'two.db') });

    // A Naby session, written the way the runtime writes it.
    const naby = store.createSession('anthropic', undefined, '/work/demo');
    store.appendMessage(naby.sessionId, { role: 'user', content: 'naby question' });
    store.appendMessage(naby.sessionId, { role: 'assistant', content: 'naby answer' });

    // Then a codex run, recorded by the orchestrator.
    const rec = createTranscriptRecorder({
      store: () => store as unknown as TranscriptStore,
      providerId: 'codex',
      cwd: '/work/demo',
      prompt: 'codex question',
    });
    rec.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'codex answer' }] } });
    rec.flush('codex-session-2');

    const recent = buildRecentSessions(undefined, store as unknown as RecentSessionsStore);

    // Both present, newest first — one list, no engine dimension anywhere in it.
    expect(recent.map((s) => s.sessionId)).toEqual(['codex-session-2', naby.sessionId]);
    expect(recent.map((s) => s.title)).toEqual(['codex question', 'naby question']);

    store.close();
  });
});
