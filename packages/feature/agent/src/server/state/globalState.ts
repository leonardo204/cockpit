import {
  getClaudeSessionPath,
  getClaude2SessionPath,
  getOllamaSessionPath,
  findCodexSessionPath,
  findKimiSessionPath,
} from '@cockpit/shared-utils';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { basename } from 'path';
import { sendPushNotification } from '../push/push';
import { generateTitle } from '../sessionTitle';
import { getStore } from '../engines/naby';
import {
  buildRecentSessions,
  statusKey,
  type RecentSession,
  type SessionStatus,
} from './recentSessions';

export type { SessionStatus };

// `~/.cockpit/state.json` IS GONE FROM THIS FILE. It used to hold a second copy
// of the recent-session list — MRU order, titles, per-session status — while the
// search panel read the Naby store, and the two were expected to agree. They did
// not, twice over. Everything a recent view needs now lives in `app.db`:
//   - the list and its MRU order → the `sessions` table,
//   - titles and previews        → the `messages` table,
//   - run/read status            → the `session.status.<id>` setting written
//                                  below and cleared by the "mark read" path.
// What remains here is the STATUS WRITER plus the transcript readers other
// engines use for their own titles.

const MAX_TEXT_LEN = 50; // max character count for the push-notification body

/** Truncate by Unicode characters, appending an ellipsis if over the limit */
function truncate(s: string | undefined): string | undefined {
  if (!s) return s;
  const chars = [...s]; // expand to code-point array; each emoji/CJK char counts as 1
  return chars.length <= MAX_TEXT_LEN ? s : chars.slice(0, MAX_TEXT_LEN).join('') + '…';
}

/**
 * Record a session's coarse run/read status, and notify once when a run ends.
 *
 * This is a STORE write. There is no file to lock and no list to prune: the
 * recent views derive their list and their order from the store's own
 * `sessions` table, so the only thing a run has to publish is what changed —
 * its status. `title` and `lastUserMessage` are no longer persisted here
 * either; the views read both from the store's messages, which cannot go stale
 * the way a snapshot copy did.
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

  // The previous status is the de-dup gate for the notification below, and it
  // has to be read from the same place the new one is written — reading it from
  // one store while writing to another is precisely how the badge used to stick.
  let previous: string | undefined;
  try {
    const store = getStore();
    previous = store.getSetting(statusKey(sessionId));
    store.setSetting(statusKey(sessionId), status);
  } catch {
    // A status write must never fail a run. The cost of losing it is a stale
    // dot, and the next turn overwrites it anyway.
    return;
  }

  // Web Push: notify once when a run finishes (status enters 'unread').
  // Gated on the previous status so repeated 'unread' writes don't re-notify.
  // Fire-and-forget — never blocks or fails the status write.
  if (status === 'unread' && previous !== 'unread') {
    void (async () => {
      // Read the transcript for the *actual* latest user prompt at completion
      // time — authoritative even for scheduled-task / failure writes that
      // don't carry a fresh lastUserMessage. Fall back to the caller's value,
      // then the title. Empty → SW localizes the body.
      const fresh = await getLastUserMessage(cwd, sessionId).catch(() => undefined);
      await sendPushNotification({
        title: basename(cwd) || 'Cockpit',
        body: truncate(fresh || lastUserMessage) || truncate(title) || '',
        data: { cwd, sessionId },
      });
    })().catch(() => {});
  }
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

/**
 * The shape the /ws/global-state channel pushes. Identical to what the search
 * panel receives, because it is the same row from the same builder — the two
 * views differ in how much of it they render, not in where it came from.
 */
export type GlobalSessionSnapshot = RecentSession;

/**
 * Build the recent-sessions snapshot (top `limit`) for:
 *   - the WS handler (src/lib/effect/globalStateHandler.ts), and
 *   - the /m server page, which SSRs the list so first paint doesn't wait for
 *     JS download + hydration + WS handshake (a ~2s tax on tunneled links).
 *
 * A thin wrapper over the shared builder, kept async because both callers await
 * it. The dropdown does not search, so it skips the search corpus.
 */
export async function getGlobalSessionsSnapshot(limit = 15): Promise<GlobalSessionSnapshot[]> {
  return buildRecentSessions({ limit });
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

