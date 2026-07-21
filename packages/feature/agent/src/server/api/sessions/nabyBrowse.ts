/**
 * nabyBrowse — shared mappers that render Naby store (`app.db`) data into the
 * session-browsing wire shapes (Phase C-2).
 *
 * THE POINT OF THIS FILE: every session/project *browsing* surface now sources
 * its data from `getStore()` — the same database the engine writes — and NOT
 * from `~/.claude/projects/*.jsonl`, `~/.cockpit/state.json`,
 * `pinned-sessions.json`, or any codex/kimi/ollama transcript directory. So the
 * browsers list ONLY the projects/sessions the user opened *through Naby*,
 * instead of every directory the underlying `claude` CLI was ever run in.
 *
 * These helpers touch NO filesystem transcript source — only the store.
 */
import { encodePath } from '@cockpit/shared-utils';
import { getStore } from '../../engines/naby';
import type { RuntimeMessage, SessionRef } from '../../engines/naby';

export const UNTITLED = 'Untitled Session';

// Display fields mirror the old jsonl-derived shapes: messages truncated to 50
// chars, sampled as first-5 + last-5 (or all when ≤10).
const MAX_TEXT_LEN = 50;
const SAMPLE_THRESHOLD = 10;
const SAMPLE_HEAD = 5;
const SAMPLE_TAIL = 5;
const TITLE_MAX = 80;

// Engine badges the browsing cards know how to render. A Naby session records a
// `providerId` (a backend hint, e.g. 'anthropic'), not one of these UI labels;
// we only surface a badge when the provider IS one of the known labels, so the
// common case shows no badge (matching the old 'claude' default) rather than a
// spurious provider-name badge on every card.
const ENGINE_LABELS = new Set(['claude', 'claude2', 'ollama', 'codex', 'kimi']);

export function engineFromProvider(providerId: string | undefined): string | undefined {
  if (!providerId) return undefined;
  return ENGINE_LABELS.has(providerId) ? providerId : undefined;
}

function truncate(msg: string): string {
  return msg.length <= MAX_TEXT_LEN ? msg : msg.slice(0, MAX_TEXT_LEN) + '...';
}

/** Every user message's text, in append order. Tool/assistant rows are skipped
 *  — the previews sample user turns, exactly like the old jsonl readers did. */
export function userTexts(messages: RuntimeMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === 'user' && m.content.trim()) out.push(m.content);
  }
  return out;
}

/** Display title: the session's stored title, else its first user message
 *  (clipped), else a stable placeholder. */
export function deriveTitle(ref: SessionRef, texts: string[]): string {
  if (ref.title && ref.title.trim()) return ref.title;
  const first = texts[0];
  if (first) return first.length <= TITLE_MAX ? first : first.slice(0, TITLE_MAX) + '...';
  return UNTITLED;
}

/** First-5 / last-5 (or all when ≤10) sample of user texts, each truncated —
 *  the card preview lines. */
export function sampleMessages(texts: string[]): { firstMessages: string[]; lastMessages: string[] } {
  if (texts.length <= SAMPLE_THRESHOLD) {
    return { firstMessages: texts.map(truncate), lastMessages: [] };
  }
  return {
    firstMessages: texts.slice(0, SAMPLE_HEAD).map(truncate),
    lastMessages: texts.slice(-SAMPLE_TAIL).map(truncate),
  };
}

/**
 * The per-project session card shape. NOTE the `path` field: the browsers
 * (SessionBrowser / ProjectSessionsModal) derive a sessionId from it via
 * `path.split('/').pop().replace('.jsonl','')`. A bare sessionId round-trips
 * through that unchanged (no slash, no `.jsonl`), so we put the sessionId there
 * and the existing click→open-session flow keeps working with no client edit.
 */
export interface NabySessionInfo {
  path: string;
  title: string;
  modifiedAt: string;
  firstMessages: string[];
  lastMessages: string[];
  searchText: string;
  engine?: string;
}

/** Build one session card from its ref, reading the transcript from the store's
 *  messages table (never a `.jsonl`). */
export function buildSessionInfo(ref: SessionRef): NabySessionInfo {
  const messages = getStore().getMessages(ref.sessionId);
  const texts = userTexts(messages);
  const title = deriveTitle(ref, texts);
  const { firstMessages, lastMessages } = sampleMessages(texts);
  return {
    path: ref.sessionId,
    title,
    modifiedAt: new Date(ref.lastUsedAt).toISOString(),
    firstMessages,
    lastMessages,
    // Untruncated, lowercased corpus for the search panel: title + every user
    // message. Display fields above stay truncated/sampled; matching reads this.
    searchText: [title, ...texts].join('\n').toLowerCase(),
    engine: engineFromProvider(ref.providerId),
  };
}

/**
 * Resolve an encoded project directory name back to a real cwd by matching it
 * against the store's project list. Two encodings reach this route from two
 * different clients, and this tolerates BOTH:
 *   - SessionBrowser passes the `encodedPath` the projects route emits
 *     (`encodePath`: `/` AND `.` → `-`).
 *   - ProjectSessionsModal computes its own (`cwd.replace(/\//g, '-')`: only
 *     `/` → `-`).
 * Both encodings are lossy, so we never decode — we match the request against
 * the encodings of KNOWN Naby projects and return the exact cwd.
 */
export function resolveCwdFromEncoded(encoded: string): string | undefined {
  for (const p of getStore().listProjects()) {
    if (encodePath(p.cwd) === encoded) return p.cwd;
    if (p.cwd.replace(/\//g, '-') === encoded) return p.cwd;
    if (p.cwd === encoded) return p.cwd;
  }
  return undefined;
}
