/**
 * /api/sessions/projects/[encodedPath] — the sessions of one project, for the
 * SessionBrowser (expand a project) and ProjectSessionsModal.
 *
 * RE-BACKED ONTO THE NABY STORE (Phase C-2). The session list is now
 * `listSessionsByProject(cwd)` from `app.db` (the sessions LINKED to that cwd),
 * MRU-ordered. Each card's title / preview / search text is built from the
 * session's messages in the store's messages table — NOT from any `.jsonl`,
 * cockpit `session.json`, or codex/kimi transcript file. Empty/unrelated CLI
 * sessions no longer appear; only Naby's own sessions for this project do.
 *
 * The WIRE CONTRACT is unchanged — an array of
 * `SessionInfo { path, title, modifiedAt, firstMessages[], lastMessages[],
 * searchText, engine? }`. The one semantic shift is `path`: it now carries the
 * bare sessionId. The browsers derive a sessionId from it via
 * `path.split('/').pop().replace('.jsonl','')`, which returns a bare id
 * unchanged — so the click→open-session flow keeps working with no client edit.
 */
import { Effect } from 'effect';
import { dynamicHandler } from '@cockpit/effect-runtime/server';
import { AppError, ValidationError } from '@cockpit/effect-core';
import { getStore } from '../../engines/naby';
import { buildSessionInfo, resolveCwdFromEncoded, type NabySessionInfo } from './nabyBrowse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = dynamicHandler<
  { encodedPath: string },
  AppError | ValidationError
>((_req, { encodedPath }) =>
  Effect.gen(function* () {
    if (!encodedPath) {
      return yield* Effect.fail(
        new ValidationError({ field: 'encodedPath', reason: 'missing' })
      );
    }
    const sessions = yield* Effect.try({
      try: (): NabySessionInfo[] => {
        const cwd = resolveCwdFromEncoded(encodedPath);
        // Unknown project (not opened through Naby) → no sessions, same as the
        // old "directory absent" empty result.
        if (!cwd) return [];
        // listSessionsByProject is already MRU-ordered; map each ref to a card.
        return getStore()
          .listSessionsByProject(cwd)
          .map((ref) => buildSessionInfo(ref));
      },
      catch: (cause) =>
        new AppError({ message: 'Failed to load project sessions', cause }),
    });
    return new Response(JSON.stringify(sessions), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  })
);
