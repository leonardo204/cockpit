import {
  GLOBAL_STATE_FILE,
  readJsonFile,
  writeJsonFile,
  withFileLock,
  getClaudeSessionPath,
  getClaude2SessionPath,
  getOllamaSessionPath,
  findCodexSessionPath,
  findKimiSessionPath,
} from '@cockpit/shared-utils';
import { createReadStream, existsSync, statSync } from 'fs';
import { createInterface } from 'readline';
import { basename } from 'path';
import { sendPushNotification } from '../push/push';
import { generateTitle } from '../sessionTitle';
import { getStore } from '../engines/naby';
import { CLEARED_BEFORE_KEY, isRecentVisible, parseClearedBefore } from './recentFilter';

export type SessionStatus = 'normal' | 'loading' | 'unread';

// Session run/read STATUS is unified on the Naby store (Phase C-2 follow-up).
// The engine mirrors it here, the search panel (/api/global-state) reads/writes
// it, and the "mark read" path clears it — all keyed by `session.status.<id>`.
// state.json remains the recent-list/MRU source only; its per-session `status`
// field is no longer the source of truth for the sidebar badge (see the
// snapshot override below), which fixes the badge that never cleared because
// the read (state.json) and the "mark read" write (store) disagreed.
const statusSettingKey = (sessionId: string) => `session.status.${sessionId}`;
// "Clear recents" watermark + the shared visibility predicate now live in
// ./recentFilter, imported above, so this snapshot (the sidebar dropdown) and
// the search panel (/api/global-state) apply the SAME rules and can't drift.

interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  status: SessionStatus;
  title?: string;
  lastUserMessage?: string;
  engine?: 'claude' | 'claude2' | 'codex' | 'ollama';
}

interface GlobalState {
  sessions: GlobalSession[];
}

// Retention for the persisted recent-session list, backing the search panel:
//   - keep sessions active within the last week …
//   - … but never fewer than MIN_SESSIONS (pad with older ones if the week is sparse)
//   - … and never more than MAX_SESSIONS.
// The sidebar dropdown still shows only the top 15 (sliced on the WS push path).
const MAX_SESSIONS = 100;
const MIN_SESSIONS = 15;
const RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // one week
const MAX_TEXT_LEN = 50; // max character count for title / lastUserMessage

/** Truncate by Unicode characters, appending an ellipsis if over the limit */
function truncate(s: string | undefined): string | undefined {
  if (!s) return s;
  const chars = [...s]; // expand to code-point array; each emoji/CJK char counts as 1
  return chars.length <= MAX_TEXT_LEN ? s : chars.slice(0, MAX_TEXT_LEN).join('') + '…';
}

/**
 * Update global session state.
 * Uses withFileLock to serialize concurrent read-modify-write operations,
 * preventing data loss due to race conditions when multiple tasks fire simultaneously.
 */
export async function updateGlobalState(
  cwd: string,
  sessionId: string,
  status: SessionStatus,
  title?: string,
  lastUserMessage?: string
): Promise<void> {
  // Guard: skip non-existent paths (avoids writing with a wrongly decoded cwd)
  if (!existsSync(cwd)) {
    return;
  }

  return withFileLock(GLOBAL_STATE_FILE, async () => {
    const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });

    // Migrate legacy format: isLoading → status
    for (const s of state.sessions) {
      if (!s.status) {
        const legacy = s as GlobalSession & { isLoading?: boolean };
        s.status = legacy.isLoading ? 'loading' : 'normal';
        delete legacy.isLoading;
      }
    }

    // Check if the session already exists
    const existingIndex = state.sessions.findIndex(
      s => s.cwd === cwd && s.sessionId === sessionId
    );
    const existed = existingIndex >= 0;
    const existing = existed ? state.sessions[existingIndex] : undefined;

    const newSession: GlobalSession = {
      cwd,
      sessionId,
      lastActive: Date.now(),
      status,
      title: truncate(title || existing?.title),
      lastUserMessage: truncate(lastUserMessage || existing?.lastUserMessage),
    };

    if (existingIndex >= 0) {
      state.sessions[existingIndex] = newSession;
    } else {
      state.sessions.push(newSession);
    }

    // Sort by lastActive descending
    state.sessions.sort((a, b) => b.lastActive - a.lastActive);

    // Retention: keep the past week, clamped to [MIN_SESSIONS, MAX_SESSIONS].
    // Sessions are sorted newest-first, so the within-week ones are a contiguous
    // prefix — counting them gives the cut point directly.
    const cutoff = Date.now() - RETENTION_WINDOW_MS;
    const withinWeek = state.sessions.filter((s) => s.lastActive >= cutoff).length;
    const keep = Math.min(MAX_SESSIONS, Math.max(MIN_SESSIONS, withinWeek));
    state.sessions = state.sessions.slice(0, keep);

    await writeJsonFile(GLOBAL_STATE_FILE, state);

    // Mirror the coarse status into the Naby store so the sidebar badge and the
    // search panel (which read `session.status.<id>`) agree with the engine.
    // Non-fatal: state.json above is the recent-list source; the store is the
    // status source of truth. A store failure must never fail the run.
    try {
      getStore().setSetting(statusSettingKey(sessionId), status);
    } catch {
      /* store optional — never fail the state write */
    }

    // Web Push: notify once when a run finishes (status enters 'unread').
    // Gated on the previous status so repeated 'unread' writes don't re-notify.
    // Fire-and-forget — never blocks or fails the state write.
    if (status === 'unread' && existing?.status !== 'unread') {
      void (async () => {
        // Read the transcript for the *actual* latest user prompt at completion
        // time — authoritative even for scheduled-task / failure writes that
        // don't carry a fresh lastUserMessage. Fall back to the cached value,
        // then the title. Empty → SW localizes the body.
        const fresh = await getLastUserMessage(cwd, sessionId).catch(() => undefined);
        const last = fresh || newSession.lastUserMessage;
        await sendPushNotification({
          title: basename(cwd) || 'Cockpit',
          body: truncate(last) || newSession.title || '',
          data: { cwd, sessionId },
        });
      })().catch(() => {});
    }
  });
}

/**
 * Read the session title from a transcript file.
 */
export async function getSessionTitle(cwd: string, sessionId: string): Promise<string> {
  const claudePath = getClaudeSessionPath(cwd, sessionId);
  if (existsSync(claudePath)) {
    return getClaudeStyleTitle(claudePath);
  }

  const claude2Path = getClaude2SessionPath(cwd, sessionId);
  if (existsSync(claude2Path)) {
    return getClaudeStyleTitle(claude2Path);
  }

  const ollamaPath = getOllamaSessionPath(cwd, sessionId);
  if (existsSync(ollamaPath)) {
    return getClaudeStyleTitle(ollamaPath);
  }

  const codexPath = findCodexSessionPath(sessionId);
  if (codexPath && existsSync(codexPath)) {
    const title = await getCodexTitle(codexPath);
    return title || 'Untitled Session';
  }

  const kimiPath = findKimiSessionPath(sessionId);
  if (kimiPath && existsSync(kimiPath)) {
    const title = await getKimiTitle(kimiPath);
    return title || 'Untitled Session';
  }

  return 'Untitled Session';
}

/**
 * Collect every valid user message from a transcript file, in order,
 * dispatching by engine format (Claude-style / Codex / Kimi).
 */
async function collectUserMessages(cwd: string, sessionId: string): Promise<string[]> {
  const claudePath = getClaudeSessionPath(cwd, sessionId);
  if (existsSync(claudePath)) {
    return await getClaudeStyleUserMessages(claudePath);
  }

  const claude2Path = getClaude2SessionPath(cwd, sessionId);
  if (existsSync(claude2Path)) {
    return await getClaudeStyleUserMessages(claude2Path);
  }

  const ollamaPath = getOllamaSessionPath(cwd, sessionId);
  if (existsSync(ollamaPath)) {
    return await getClaudeStyleUserMessages(ollamaPath);
  }

  const codexPath = findCodexSessionPath(sessionId);
  if (codexPath && existsSync(codexPath)) {
    return await getCodexUserMessages(codexPath);
  }

  const kimiPath = findKimiSessionPath(sessionId);
  if (kimiPath && existsSync(kimiPath)) {
    return await getKimiUserMessages(kimiPath);
  }

  return [];
}

/**
 * Read the last user message from a transcript file.
 */
export async function getLastUserMessage(cwd: string, sessionId: string): Promise<string | undefined> {
  const messages = await collectUserMessages(cwd, sessionId);
  return messages[messages.length - 1];
}

const SUMMARY_THRESHOLD = 10; // ≤ this many messages → all go into firstMessages
const SUMMARY_HEAD = 5;
const SUMMARY_TAIL = 5;

export const UNTITLED_SESSION = 'Untitled Session';

export interface SessionPreview {
  /** Live title (summary line preferred), regenerated from disk on every read. */
  title: string;
  lastUserMessage?: string;
  firstMessages: string[];
  lastMessages: string[];
  /**
   * Full, UNTRUNCATED, lowercased corpus for the search panel: summary + every
   * user message in order. Display fields (first/last) stay truncated+sampled;
   * matching must not inherit that lossiness, so search reads this instead.
   * Only populated when the caller passes `{ includeSearchText: true }` (the
   * search-panel GET); the WS snapshot leaves it empty to skip the join cost.
   */
  searchText: string;
}

/** Session content read in a single pass: aiTitle + summary line + all user messages. */
interface SessionContent {
  aiTitle: string;
  summary: string;
  messages: string[];
}

/**
 * Resolve the on-disk transcript path for a session plus the reader that parses
 * it into SessionContent, dispatching by engine. Codex/Kimi transcripts have no
 * summary line (their title is the first user message, already in `messages`).
 * Returns null when no transcript exists on any known path.
 */
function resolveSessionFile(
  cwd: string,
  sessionId: string
): { path: string; read: (p: string) => Promise<SessionContent> } | null {
  const claudePath = getClaudeSessionPath(cwd, sessionId);
  if (existsSync(claudePath)) return { path: claudePath, read: getClaudeStyleContent };

  const claude2Path = getClaude2SessionPath(cwd, sessionId);
  if (existsSync(claude2Path)) return { path: claude2Path, read: getClaudeStyleContent };

  const ollamaPath = getOllamaSessionPath(cwd, sessionId);
  if (existsSync(ollamaPath)) return { path: ollamaPath, read: getClaudeStyleContent };

  const codexPath = findCodexSessionPath(sessionId);
  if (codexPath && existsSync(codexPath)) {
    return {
      path: codexPath,
      read: async (p) => ({ aiTitle: '', summary: '', messages: await getCodexUserMessages(p) }),
    };
  }

  const kimiPath = findKimiSessionPath(sessionId);
  if (kimiPath && existsSync(kimiPath)) {
    return {
      path: kimiPath,
      read: async (p) => ({ aiTitle: '', summary: '', messages: await getKimiUserMessages(p) }),
    };
  }

  return null;
}

// ── Parsed-content cache keyed by file fingerprint (mtime+size) ──────────────
// getSessionContent streams and JSON.parses an entire transcript. The WS
// snapshot re-runs it for the top-15 sessions on every state.json write — i.e.
// on every chat-tab session switch — even though a switch never mutates any
// transcript. Cache the *parsed* SessionContent (small: only user messages +
// title lines, never the multi-MB assistant/tool bytes) per resolved path,
// invalidated by an mtime+size fingerprint. A switch then costs one statSync per
// session instead of a full read+parse; an active run or an external `claude -r`
// append changes the fingerprint and re-reads naturally. Bounded LRU.
const CONTENT_CACHE_MAX = 40;
const contentCache = new Map<string, { fingerprint: string; content: SessionContent }>();

/** Cheap change token — mtime + size, same idea as session-by-path's getFileFingerprint. */
function fileFingerprint(filePath: string): string {
  const st = statSync(filePath);
  return `${st.mtimeMs}-${st.size}`;
}

/**
 * Collect the summary line plus every user message in a single file pass,
 * dispatching by engine. Result is cached by file fingerprint so repeated reads
 * of an unchanged transcript (the snapshot recompute on every tab switch) skip
 * the read+parse entirely.
 */
async function getSessionContent(cwd: string, sessionId: string): Promise<SessionContent> {
  const resolved = resolveSessionFile(cwd, sessionId);
  if (!resolved) return { aiTitle: '', summary: '', messages: [] };

  let fingerprint = '';
  try {
    fingerprint = fileFingerprint(resolved.path);
    const cached = contentCache.get(resolved.path);
    if (cached && cached.fingerprint === fingerprint) {
      // LRU touch: re-insert so it counts as most-recently-used.
      contentCache.delete(resolved.path);
      contentCache.set(resolved.path, cached);
      return cached.content;
    }
  } catch {
    // stat failed (race with deletion, etc.) — fall through to a fresh read.
  }

  const content = await resolved.read(resolved.path);

  if (fingerprint) {
    contentCache.delete(resolved.path);
    contentCache.set(resolved.path, { fingerprint, content });
    if (contentCache.size > CONTENT_CACHE_MAX) {
      const oldest = contentCache.keys().next().value;
      if (oldest !== undefined) contentCache.delete(oldest);
    }
  }
  return content;
}

/**
 * Read a session preview in a single pass: a live title, the last user message,
 * a first/last message preview (mirroring ProjectSessionsModal cards — ≤10
 * messages → all in firstMessages; otherwise first 5 + last 5, each truncated to
 * MAX_TEXT_LEN), and an untruncated `searchText` corpus for the search panel.
 */
export async function getSessionPreview(
  cwd: string,
  sessionId: string,
  opts?: { includeSearchText?: boolean }
): Promise<SessionPreview> {
  const { aiTitle, summary, messages } = await getSessionContent(cwd, sessionId);
  const title = generateTitle(aiTitle, summary, messages);
  const lastUserMessage = messages[messages.length - 1];
  // Untruncated, unsampled corpus — keeps long messages and mid-conversation
  // messages searchable even though the display fields below drop them. Only the
  // search panel (/api/global-state GET) needs it; the WS snapshot never reads
  // searchText, so skip the multi-MB join+toLowerCase there.
  const searchText = opts?.includeSearchText ? [summary, ...messages].join('\n').toLowerCase() : '';
  if (messages.length <= SUMMARY_THRESHOLD) {
    return { title, lastUserMessage, firstMessages: messages.map((m) => truncate(m)!), lastMessages: [], searchText };
  }
  return {
    title,
    lastUserMessage,
    firstMessages: messages.slice(0, SUMMARY_HEAD).map((m) => truncate(m)!),
    lastMessages: messages.slice(-SUMMARY_TAIL).map((m) => truncate(m)!),
    searchText,
  };
}

/** GlobalSession enriched with the preview fields the session list renders. */
export interface GlobalSessionSnapshot extends GlobalSession {
  firstMessages?: string[];
  lastMessages?: string[];
}

/**
 * Build the recent-sessions snapshot (top `limit`, previews attached) — the
 * exact shape the /ws/global-state channel pushes. Shared by:
 *   - the WS handler (src/lib/effect/globalStateHandler.ts), and
 *   - the /m server page, which SSRs the list so first paint doesn't wait for
 *     JS download + hydration + WS handshake (a ~2s tax on tunneled links).
 */
export async function getGlobalSessionsSnapshot(limit = 15): Promise<GlobalSessionSnapshot[]> {
  const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });

  // backward-compat: isLoading → status
  for (const s of state.sessions) {
    if (!s.status) {
      const legacy = s as GlobalSession & { isLoading?: boolean };
      s.status = legacy.isLoading ? 'loading' : 'normal';
    }
  }

  // STATUS + CLEAR come from the Naby store (single source of truth). Read them
  // best-effort so a store failure degrades to the state.json values rather than
  // breaking the snapshot:
  //   - override each session's status with `session.status.<id>` (the value the
  //     "mark read" path writes) so viewing a session clears the badge, and
  //   - drop sessions hidden by a "clear recents" watermark.
  let clearedBefore = 0;
  try {
    const store = getStore();
    clearedBefore = parseClearedBefore(store.getSetting(CLEARED_BEFORE_KEY));
    for (const s of state.sessions) {
      const st = store.getSetting(statusSettingKey(s.sessionId));
      if (st) s.status = st as SessionStatus;
    }
  } catch {
    /* store unavailable — fall back to the state.json status values */
  }
  // Same shared predicate the search panel uses (watermark + projectless
  // inclusion). state.json sessions always carry a cwd, so the projectless rule
  // is a no-op here today, but sharing the predicate keeps the two views from
  // drifting on the watermark boundary.
  state.sessions = state.sessions.filter((s) => isRecentVisible(s, clearedBefore));

  state.sessions.sort((a, b) => b.lastActive - a.lastActive);
  const recent = state.sessions.slice(0, limit);

  return Promise.all(
    recent.map(async (session): Promise<GlobalSessionSnapshot> => {
      // Actively-loading sessions already carry a fresh lastUserMessage.
      if (session.status === 'loading' && session.lastUserMessage) return session;
      try {
        const preview = await getSessionPreview(session.cwd, session.sessionId);
        return {
          ...session,
          // Re-derive the title from disk on every read (aiTitle > summary >
          // first message) instead of trusting the value persisted in
          // state.json — that snapshot is only refreshed when a run finishes,
          // so it goes stale whenever the aiTitle lands after completion.
          // Fall back to the persisted title only when the transcript is gone
          // (preview degrades to UNTITLED_SESSION). Mirrors /api/global-state.
          title:
            preview.title !== UNTITLED_SESSION
              ? preview.title
              : (session.title ?? preview.title),
          lastUserMessage: preview.lastUserMessage ?? session.lastUserMessage,
          firstMessages: preview.firstMessages,
          lastMessages: preview.lastMessages,
        };
      } catch {
        return session; // preview is best-effort — never block the snapshot
      }
    })
  );
}

/**
 * Strip command and system tags from a message.
 */
function filterCommandTags(text: string): string {
  // Remove <command-*> tags and their content
  let filtered = text.replace(/<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g, '');
  // Remove <local-command-*> tags and their content
  filtered = filtered.replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g, '');
  // Strip extra whitespace
  filtered = filtered.trim();
  return filtered;
}

/**
 * Check whether a message is a valid user message (not a system message).
 */
function isValidUserMessage(text: string): boolean {
  // Filter out system context messages
  if (text.startsWith('This session is being continued')) return false;
  if (text.startsWith('Caveat: The messages below')) return false;
  // Filter out empty messages
  if (!text.trim()) return false;
  return true;
}

// ============================================
// Transcript readers (Claude-style, Codex, Kimi)
// ============================================

// Snapshot readers only consume `user`, `summary`, and `ai-title` lines — all
// small. The bulk of a transcript's bytes are large `assistant` / tool_result
// lines we discard, and JSON.parse-ing those (big string alloc + object graph +
// GC) is the dominant cost on a cold read. A cheap byte scan for the wanted
// type markers lets us skip parsing any line that can't be one of the three,
// cutting parse volume by ~1-2 orders of magnitude on big transcripts.
//
// Compact machine-written JSONL guarantees the `"type":"x"` form (no spaces); a
// space-padded variant is tolerated defensively. A false positive only wastes
// one parse; a false negative only yields a slightly stale preview title (this
// is best-effort code wrapped in try/catch), never a crash.
const SNAPSHOT_TYPE_MARKERS = [
  '"type":"user"',
  '"type": "user"',
  '"type":"summary"',
  '"type": "summary"',
  '"type":"ai-title"',
  '"type": "ai-title"',
];
function isSnapshotRelevantLine(line: string): boolean {
  for (const marker of SNAPSHOT_TYPE_MARKERS) {
    if (line.includes(marker)) return true;
  }
  return false;
}

async function getClaudeStyleTitle(filePath: string): Promise<string> {
  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    let aiTitle = '';
    let summary = '';
    const userMessages: string[] = [];

    for await (const line of rl) {
      if (!line.trim()) continue;
      // Skip lines that can't be a wanted type before the expensive JSON.parse.
      if (!isSnapshotRelevantLine(line)) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'ai-title' && entry.aiTitle) {
          aiTitle = entry.aiTitle;
        }
        if (entry.type === 'summary' && entry.summary) {
          summary = entry.summary;
        }
        if (entry.type === 'user') {
          const message = entry.message;
          if (!message?.content) continue;
          if (typeof message.content === 'string') {
            userMessages.push(message.content);
          } else if (Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === 'text' && block.text) userMessages.push(block.text);
            }
          }
        }
      } catch {
        // ignore
      }
    }

    return generateTitle(aiTitle, summary, userMessages);
  } catch {
    return 'Untitled Session';
  }
}

async function getClaudeStyleUserMessages(filePath: string): Promise<string[]> {
  const messages: string[] = [];
  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      // Skip lines that can't be a wanted type before the expensive JSON.parse.
      if (!isSnapshotRelevantLine(line)) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user') continue;

        const message = entry.message;
        if (!message?.content) continue;

        let text = '';
        if (typeof message.content === 'string') {
          text = message.content;
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'text' && block.text) {
              text = block.text;
              break;
            }
          }
        }

        if (!text) continue;
        const filtered = filterCommandTags(text);
        if (filtered && isValidUserMessage(filtered)) {
          messages.push(filtered);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return messages;
}

/**
 * Single-pass Claude-style reader returning the summary line plus the filtered
 * user messages (same filtering as getClaudeStyleUserMessages). Lets
 * getSessionPreview build title + preview + search corpus from one file read.
 */
async function getClaudeStyleContent(filePath: string): Promise<SessionContent> {
  let aiTitle = '';
  let summary = '';
  const messages: string[] = [];
  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      // Skip lines that can't be a wanted type before the expensive JSON.parse.
      if (!isSnapshotRelevantLine(line)) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'ai-title' && entry.aiTitle) {
          aiTitle = entry.aiTitle;
          continue;
        }
        if (entry.type === 'summary' && entry.summary) {
          summary = entry.summary;
          continue;
        }
        if (entry.type !== 'user') continue;

        const message = entry.message;
        if (!message?.content) continue;

        let text = '';
        if (typeof message.content === 'string') {
          text = message.content;
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'text' && block.text) {
              text = block.text;
              break;
            }
          }
        }

        if (!text) continue;
        const filtered = filterCommandTags(text);
        if (filtered && isValidUserMessage(filtered)) {
          messages.push(filtered);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return { aiTitle, summary, messages };
}

async function getCodexUserMessages(filePath: string): Promise<string[]> {
  const messages: string[] = [];
  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: { type?: string; payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type !== 'response_item') continue;
      const payload = entry.payload;
      if (!payload || payload.type !== 'message' || payload.role !== 'user') continue;

      const text =
        payload.content
          ?.filter((c) => c.type === 'input_text' && c.text)
          .map((c) => c.text!)
          .join('') || '';

      if (!text || text.startsWith('<') || text.startsWith('#')) continue;

      const filtered = filterCommandTags(text);
      if (filtered && isValidUserMessage(filtered)) {
        messages.push(filtered);
      }
    }
  } catch {
    // ignore
  }
  return messages;
}

async function getCodexTitle(filePath: string): Promise<string | undefined> {
  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: { type?: string; payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type !== 'response_item') continue;
      const payload = entry.payload;
      if (!payload || payload.type !== 'message' || payload.role !== 'user') continue;

      const text =
        payload.content
          ?.filter((c) => c.type === 'input_text' && c.text)
          .map((c) => c.text!)
          .join('') || '';

      if (!text || text.startsWith('<') || text.startsWith('#')) continue;
      return text.slice(0, 80);
    }

    return undefined;
  } catch {
    return undefined;
  }
}

async function getKimiUserMessages(filePath: string): Promise<string[]> {
  const messages: string[] = [];
  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.role !== 'user') continue;

      const text =
        typeof entry.content === 'string'
          ? entry.content
          : Array.isArray(entry.content)
            ? entry.content
                .filter((c) => (c.type === 'input_text' || c.type === 'text') && c.text)
                .map((c) => c.text!)
                .join('')
            : '';

      if (
        !text ||
        text.startsWith('<system') ||
        text.startsWith('<environment') ||
        text.startsWith('# AGENTS.md') ||
        text.startsWith('<permissions')
      ) {
        continue;
      }

      const filtered = filterCommandTags(text);
      if (filtered && isValidUserMessage(filtered)) {
        messages.push(filtered);
      }
    }
  } catch {
    // ignore
  }
  return messages;
}

async function getKimiTitle(filePath: string): Promise<string | undefined> {
  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.role !== 'user') continue;

      const text =
        typeof entry.content === 'string'
          ? entry.content
          : Array.isArray(entry.content)
            ? entry.content
                .filter((c) => (c.type === 'input_text' || c.type === 'text') && c.text)
                .map((c) => c.text!)
                .join('')
            : '';

      if (
        !text ||
        text.startsWith('<system') ||
        text.startsWith('<environment') ||
        text.startsWith('# AGENTS.md') ||
        text.startsWith('<permissions')
      ) {
        continue;
      }

      return text.slice(0, 80);
    }

    return undefined;
  } catch {
    return undefined;
  }
}

