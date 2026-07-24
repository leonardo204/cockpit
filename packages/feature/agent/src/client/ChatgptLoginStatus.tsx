'use client';

/**
 * The ChatGPT (subscription) account chip — the sibling of `ClaudeLoginStatus`,
 * and built to the SAME chip + popover shape so the two sign-ins read as one
 * control strip. The bottom bar shows exactly ONE of them at a time, switched by
 * Chat on the active engine: this chip appears only when the ChatGPT subscription
 * provider (`ai-sdk` + `openai-chatgpt-oauth`) is the engine that will answer.
 *
 * WHAT IT IS. A DEV-ONLY convenience: it answers chats on the developer's
 * signed-in ChatGPT subscription instead of a metered API key, over the
 * UNOFFICIAL ChatGPT backend (a ToS grey zone). It is never part of a shipped
 * build, and the popover says so — a small "dev only · ToS caution" label that
 * keeps the "not endorsed by OpenAI" nuance without shouting from the row.
 *
 * SEAL-GATED, OVER HTTP. This chip reads its status the SAME way the Claude chip
 * does — a plain `/api/naby` fetch — NOT the `window.naby.chatgptOauth` preload
 * bridge. That is the whole fix: the chat bottom bar renders inside the project
 * IFRAME, where `window.naby` does not exist, so the old IPC-based chip could
 * never read its status there and thus never appeared. `chatgptLogin.available`
 * in the GET is the dev seal on the server (`isChatgptOauthEnabled()`); when it
 * is false — every official/packaged build — this component renders NOTHING at
 * all. It never offers a sign-in the app cannot honour. (Chat only mounts it for
 * the ChatGPT engine anyway; this is the second, hard gate.)
 *
 * THE CHIP (mirrors the Claude chip):
 *   ● Signed in   green   the account EMAIL + a "ChatGPT" badge. Click → menu.
 *   ● Signed out  amber   a "ChatGPT" label. Click → menu with "Sign in".
 *
 * THE ACCOUNT MENU (click the chip):
 *   * WHO — the account email from the GET status (labels only, no token).
 *   * A small dev-only / ToS caution line.
 *   * Sign out (signed in) or Sign in with ChatGPT (signed out).
 *
 * NO SECRETS. The GET's `chatgptLogin` block carries labels only ({available,
 * signedIn, email, accountId}); the OAuth tokens live in the safeStorage vault
 * in the main process and never cross back. The server runs the whole PKCE flow
 * on the main side (through the in-process account bridge) and the POST resolves
 * with the fresh status, so the chip updates as soon as the sign-in lands. The
 * 30s poll plus focus/visibility re-probe still catch a sign-in/out done
 * ELSEWHERE (the Settings card, another window).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Labels only — never a token. `available` reflects the dev seal. The exact
 *  `chatgptLogin` block shape the `/api/naby` GET returns. */
type ChatgptOauthStatus = {
  available: boolean;
  signedIn: boolean;
  email: string | null;
  accountId: string | null;
};

/**
 * Background re-probe cadence, matching EngineSwitcher. The sign-in this chip
 * reflects can be performed ELSEWHERE — the Settings card's ChatGPT row runs the
 * very same sign-in, and it (like EngineSwitcher) refreshes on a poll/focus.
 * Unhurried on purpose: focus and visibility catch the common cases far sooner
 * than the interval.
 */
const POLL_MS = 30_000;

export function ChatgptLoginStatus() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ChatgptOauthStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards a state update after the tab is closed mid-request.
  const aliveRef = useRef(true);
  const rootRef = useRef<HTMLSpanElement>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/naby');
      if (!res.ok) return;
      const data = (await res.json()) as { chatgptLogin?: ChatgptOauthStatus };
      // An older server (or a build without the runtime) simply omits the field;
      // rendering nothing is the correct degradation.
      if (aliveRef.current && data.chatgptLogin) setStatus(data.chatgptLogin);
    } catch {
      // A failed probe keeps the last known answer; the send path surfaces any
      // real failure with a far clearer message than a status dot could.
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void reload();
    // Re-probe like EngineSwitcher and the Settings card: on a slow poll and on
    // focus/visibility. This is what lets a sign-in or sign-out performed
    // ELSEWHERE (the Settings card's ChatGPT row, another window) reach this chip.
    const id = setInterval(() => void reload(), POLL_MS);
    const onFocus = () => void reload();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  // Close the menu on an outside click or Escape — a popover in the three-panel
  // layout must not linger once the user has moved on. Mirrors the Claude chip.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const signIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // The server runs the whole browser PKCE flow on the main side (through the
      // in-process account bridge) and the POST resolves with the fresh status
      // once the tokens are stored — no client poll needed. The `busy` state shows
      // "Waiting for browser sign-in…" for the duration.
      const res = await fetch('/api/naby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'chatgpt-oauth.signin' }),
      });
      if (!aliveRef.current) return;
      const body = (await res.json().catch(() => null)) as
        | { chatgpt?: ChatgptOauthStatus; error?: string }
        | null;
      if (res.ok && body?.chatgpt) setStatus(body.chatgpt);
      else setError(body?.error ?? t('chatgptOauth.signInFailed', { defaultValue: 'Could not sign in.' }));
    } catch {
      if (aliveRef.current) setError(t('chatgptOauth.signInFailed', { defaultValue: 'Could not sign in.' }));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [t]);

  const signOut = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/naby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'chatgpt-oauth.signout' }),
      });
      if (!aliveRef.current) return;
      const body = (await res.json().catch(() => null)) as { chatgpt?: ChatgptOauthStatus } | null;
      if (res.ok && body?.chatgpt) setStatus(body.chatgpt);
    } catch {
      // Leave the chip as-is on failure; the next status probe corrects it.
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, []);

  // No bridge, or the dev seal is closed → render nothing at all, exactly like
  // the settings card. This is the hard gate: an official/packaged build (seal
  // off) never shows the ChatGPT sign-in, regardless of what Chat asks for.
  if (!status || !status.available) return null;

  const signedIn = status.signedIn;
  const email = status.email;
  const dotClass = signedIn ? 'bg-emerald-500' : 'bg-amber-500';

  // The chip's own label: the email when signed in and known, else a short brand
  // word. Amber when signed out, mirroring the Claude chip's signed-out styling.
  const label = signedIn
    ? email ?? t('chatgptOauth.signedIn', { defaultValue: 'Signed in.' })
    : t('chatgptOauth.badge', { defaultValue: 'ChatGPT' });

  return (
    <span
      ref={rootRef}
      className="relative flex items-center gap-1.5 ml-2 pl-3 border-l border-border text-xs"
      data-testid="chatgpt-login-status"
      data-status={signedIn ? 'signed-in' : 'signed-out'}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded hover:bg-accent px-1 py-0.5"
        data-testid="chatgpt-account-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('chatgptOauth.devBadge')}
      >
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`}
          data-testid="chatgpt-login-dot"
        />
        <span
          className={signedIn ? 'text-muted-foreground' : 'text-amber-500'}
          data-testid="chatgpt-account-label"
        >
          {label}
        </span>
        {/* The provider badge rides on the chip when signed in, mirroring Claude's
            plan chip — short, non-secret, and it makes clear which account this is. */}
        {signedIn && (
          <span
            className="px-1 py-0.5 rounded bg-secondary text-foreground/80"
            data-testid="chatgpt-account-badge"
          >
            {t('chatgptOauth.badge', { defaultValue: 'ChatGPT' })}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          data-testid="chatgpt-account-menu"
          className="absolute top-full left-0 mt-1 z-50 w-72 rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-3 flex flex-col gap-2"
        >
          {/* WHO — the account email from the bridge status (labels only). */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {t('chatgptOauth.account', { defaultValue: 'Account' })}
            </span>
            <span className="text-foreground" data-testid="chatgpt-account-identity">
              {signedIn
                ? email ?? t('chatgptOauth.signedIn', { defaultValue: 'Signed in.' })
                : t('chatgptOauth.notSignedIn', { defaultValue: 'Not signed in' })}
            </span>
            {/* The dev-only / ToS caution — small, in the popover, not on the row.
                Keeps the "not endorsed by OpenAI" nuance without overwhelming. */}
            <span className="text-[11px] text-amber-600 dark:text-amber-400" data-testid="chatgpt-account-devnote">
              {t('chatgptOauth.devBadge')}
            </span>
          </div>

          <div className="border-t border-border" />

          {/* WHAT YOU CAN DO — depends on the current state. */}
          {signedIn ? (
            <button
              type="button"
              onClick={() => void signOut()}
              disabled={busy}
              data-testid="chatgpt-account-logout"
              className="text-left px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-50"
            >
              {busy
                ? t('chatgptOauth.loggingOut', { defaultValue: 'Signing out…' })
                : t('chatgptOauth.signOut', { defaultValue: 'Sign out' })}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void signIn()}
              disabled={busy}
              data-testid="chatgpt-account-login"
              className="text-left px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-50"
            >
              {busy
                ? t('chatgptOauth.waitingForBrowser', { defaultValue: 'Waiting for browser sign-in…' })
                : t('chatgptOauth.signIn', { defaultValue: 'Sign in with ChatGPT' })}
            </button>
          )}

          {error && (
            <span className="text-[11px] text-amber-500" data-testid="chatgpt-account-error">
              {error}
            </span>
          )}
        </div>
      )}
    </span>
  );
}
