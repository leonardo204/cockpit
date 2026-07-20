'use client';

/**
 * "Am I signed in to Claude?" — shown next to the execution-mode toggle.
 *
 * WHY IT LIVES HERE. The dev engine answers on the local Claude sign-in, and
 * the execution-mode row is the one place in the UI where the user is already
 * looking at that choice ("Claude Agent SDK | Claude Code CLI"). A sign-in
 * warning anywhere else is a warning the user finds only after the failure it
 * exists to prevent.
 *
 * WHAT IT SHOWS AND WHY THAT SHAPE:
 *
 *   ● Signed in    green   nothing to do
 *   ● Signed out   amber   PLUS the command that fixes it, inline — not hidden
 *                          in a tooltip, because the whole point is that the
 *                          user currently has no idea what to do. Amber, not
 *                          red: nothing has failed yet, and a red alarm on a
 *                          working app trains people to ignore red.
 *   ● Unknown      muted   we could not tell. Says so rather than guessing.
 *
 * IT NEVER BLOCKS ANYTHING. Sending stays enabled while signed out: the check
 * is a heuristic over a credential file, and an app that refuses to send because
 * its heuristic is wrong is worse than one that lets the send fail with a clear
 * error. This is advice, not a gate.
 *
 * NO SECRETS. Everything rendered here comes from /api/naby's `claudeLogin`
 * block, which the runtime builds from two expiry timestamps. There is no field
 * on the wire that could carry credential material.
 *
 * RE-CHECK TRIGGERS. The state changes when a human runs `claude login` in a
 * TERMINAL — i.e. always while this window is in the background — so window
 * focus is the trigger that matters and is the one that costs nothing. The slow
 * poll behind it only covers a token expiring while the window sits focused.
 * The runtime caches for 10s, so a burst of focus events is one filesystem read.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type ClaudeLogin = {
  status: 'signed-in' | 'signed-out' | 'unknown' | string;
  summary: string;
  remedy: string | null;
  cliFound: boolean;
  checkedAt: number;
  /** False when the dev engine is not part of this build (packaged app): the
   *  sign-in is then irrelevant and showing it would describe a capability the
   *  app does not have. */
  relevant: boolean;
};

/** Deliberately unhurried: this covers only "the token expired while the user
 *  sat here", which takes hours. Focus is what catches a fresh `claude login`. */
const POLL_MS = 60_000;

export function ClaudeLoginStatus() {
  const [login, setLogin] = useState<ClaudeLogin | null>(null);
  const [rechecking, setRechecking] = useState(false);
  // Guards against a state update on an unmounted component when a tab is
  // closed mid-request — every chat tab mounts one of these.
  const aliveRef = useRef(true);

  const load = useCallback(async (force = false) => {
    try {
      const res = await fetch(`/api/naby${force ? '?recheckLogin=1' : ''}`);
      if (!res.ok) return;
      const data = (await res.json()) as { claudeLogin?: ClaudeLogin };
      // An older server (or a build without the runtime) simply omits the
      // field; rendering nothing is the correct degradation.
      if (aliveRef.current && data.claudeLogin) setLogin(data.claudeLogin);
    } catch {
      // A failed poll keeps the last known answer. The send path surfaces any
      // real failure with a far better message than a status dot could.
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    // `focus` on the window inside the project iframe does not fire for every
    // app-level focus change, so both are listened for: `visibilitychange`
    // covers the app being brought forward, `focus` covers clicking into this
    // iframe from another part of the window.
    const onFocus = () => void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const recheck = useCallback(async () => {
    setRechecking(true);
    await load(true);
    if (aliveRef.current) setRechecking(false);
  }, [load]);

  // Absent field, or a build with no dev engine → render nothing at all rather
  // than an indicator for a capability this app does not have.
  if (!login || !login.relevant) return null;

  const status = login.status;
  const dotClass =
    status === 'signed-in'
      ? 'bg-emerald-500'
      : status === 'signed-out'
        ? 'bg-amber-500'
        : 'bg-muted-foreground/50';
  const label =
    status === 'signed-in'
      ? 'Claude: signed in'
      : status === 'signed-out'
        ? 'Claude: signed out'
        : 'Claude: unknown';

  return (
    <span
      className="flex items-center gap-1.5 ml-2 pl-3 border-l border-border text-xs"
      data-testid="claude-login-status"
      data-status={status}
      title={login.summary}
    >
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`}
        data-testid="claude-login-dot"
      />
      <span className={status === 'signed-out' ? 'text-amber-500' : 'text-muted-foreground'}>
        {label}
      </span>
      {/* The remedy is inline, not tooltip-only: a user who does not know they
          are signed out also does not know to hover. */}
      {login.remedy && (
        <span className="text-muted-foreground" data-testid="claude-login-remedy">
          — run <code className="px-1 py-0.5 rounded bg-secondary text-foreground">claude login</code>{' '}
          in a terminal
        </span>
      )}
      {/* Only offered when there is something to fix. Re-checking a green dot
          is busywork, and a button that is always there invites the poll this
          component was written to avoid. */}
      {status !== 'signed-in' && (
        <button
          type="button"
          onClick={() => void recheck()}
          disabled={rechecking}
          data-testid="claude-login-recheck"
          className="px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent disabled:opacity-50"
        >
          {rechecking ? 'Checking…' : 'Re-check'}
        </button>
      )}
    </span>
  );
}
