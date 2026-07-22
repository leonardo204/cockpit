'use client';

/**
 * The Claude account chip — sign-in status, WHO is signed in, and log in / out
 * driven from inside the app.
 *
 * WHY IT LIVES HERE. The dev engine answers on the local Claude sign-in, and the
 * execution-mode row is the one place the user is already looking at that choice.
 * A sign-in warning anywhere else is a warning found only after the failure it
 * exists to prevent.
 *
 * WHAT THE CHIP SHOWS:
 *   ● Signed in    green   the account EMAIL (from `claude auth status`) + plan.
 *                          Click for the account menu (org, plan, Log out).
 *   ● Signed out   amber   PLUS a "Log in" action inline, because the whole point
 *                          is the user does not yet know what to do. Amber not
 *                          red: nothing has failed.
 *   ● Unknown      muted   we could not tell. Says so rather than guessing.
 *
 * THE ACCOUNT MENU (click the chip):
 *   * WHO — the real email and organisation from `claude auth status` (the
 *     credential file has neither), plus the plan tier.
 *   * Log out — runs `claude auth logout` via /api/naby and re-checks, so the
 *     chip flips to signed-out immediately.
 *   * Log in — POSTs `claude.login`, which spawns `claude auth login` so the
 *     system browser opens for the OAuth flow. The app does NOT block on the
 *     user: it then POLLS `claude auth status` (force re-check, ~2s for ~60s)
 *     until the sign-in lands, showing a "waiting for browser sign-in…" state.
 *     A copy of the exact command is offered as a fallback for a headless box.
 *
 * IT NEVER BLOCKS ANYTHING. Sending stays enabled while signed out: an app that
 * refuses to send because its status probe is wrong is worse than one that lets
 * the send fail with a clear error. This is advice, not a gate.
 *
 * NO SECRETS. Everything here comes from /api/naby's `claudeLogin` block, built
 * by the runtime from `claude auth status` — identity LABELS (email, org, plan)
 * and a status word, never token material.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type ClaudeAccount = {
  /** The signed-in account's email, from `claude auth status`. */
  email: string | null;
  /** The organisation name, when reported. */
  orgName: string | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
};

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
  /** Who is signed in. Carries the real email from `claude auth status`. */
  account?: ClaudeAccount | null;
};

/** Deliberately unhurried background poll: this covers only "the token expired
 *  while the user sat here", which takes hours. Focus + the login poll catch a
 *  fresh sign-in far sooner. */
const POLL_MS = 60_000;

/** The interactive login poll: after launching the browser flow, re-check status
 *  every this-often, giving up after `LOGIN_POLL_MAX` tries (~60s total). */
const LOGIN_POLL_MS = 2_000;
const LOGIN_POLL_MAX = 30;

/** The exact command a signed-out user runs, and the copy-paste fallback for a
 *  headless machine. One string so the button and the hint cannot drift apart. */
const LOGIN_COMMAND = 'claude auth login';

export function ClaudeLoginStatus() {
  const { t } = useTranslation();
  const [login, setLogin] = useState<ClaudeLogin | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Guards against a state update on an unmounted component when a tab is
  // closed mid-request — every chat tab mounts one of these.
  const aliveRef = useRef(true);
  const rootRef = useRef<HTMLSpanElement>(null);
  // A login poll in flight, so a second click (or unmount) can cancel it.
  const loginPollRef = useRef(false);

  // Returns the freshly-fetched login so callers (the login poll) can inspect it
  // without waiting for React state to settle.
  const load = useCallback(async (force = false): Promise<ClaudeLogin | null> => {
    try {
      const res = await fetch(`/api/naby${force ? '?recheckLogin=1' : ''}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { claudeLogin?: ClaudeLogin };
      // An older server (or a build without the runtime) simply omits the
      // field; rendering nothing is the correct degradation.
      if (aliveRef.current && data.claudeLogin) setLogin(data.claudeLogin);
      return data.claudeLogin ?? null;
    } catch {
      // A failed poll keeps the last known answer. The send path surfaces any
      // real failure with a far better message than a status dot could.
      return null;
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
      loginPollRef.current = false;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // Close the menu on an outside click or Escape — a popover in the three-panel
  // layout must not linger when the user has moved on.
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

  const recheck = useCallback(async () => {
    setRechecking(true);
    await load(true);
    if (aliveRef.current) setRechecking(false);
  }, [load]);

  const logout = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/naby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claude.logout' }),
      });
      // The runtime reset its cache on logout, so a forced re-check reflects the
      // new (signed-out) truth rather than a stale 10s "signed in".
      if (res.ok) await load(true);
    } catch {
      // Leave the menu open on failure so the user can retry; the next re-check
      // or focus still corrects the displayed state.
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [load]);

  // Log in: launch the browser OAuth flow server-side, then poll status until it
  // flips to signed-in. The server does not block on the user, so neither do we —
  // we poll and let the chip update the moment the sign-in lands.
  const doLogin = useCallback(async () => {
    setLoginError(null);
    setLoggingIn(true);
    loginPollRef.current = true;
    try {
      const res = await fetch('/api/naby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claude.login' }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (aliveRef.current) {
          // The command is shown for copy-paste, so a spawn failure (headless /
          // no CLI) is recoverable by the user.
          setLoginError(body?.error ?? 'Could not start sign-in.');
          setLoggingIn(false);
        }
        loginPollRef.current = false;
        return;
      }
      // Poll `claude auth status` until the OAuth callback completes.
      for (let i = 0; i < LOGIN_POLL_MAX && loginPollRef.current && aliveRef.current; i++) {
        const st = await load(true);
        if (st?.status === 'signed-in') break;
        await new Promise((r) => setTimeout(r, LOGIN_POLL_MS));
      }
    } catch {
      if (aliveRef.current) setLoginError('Could not start sign-in.');
    } finally {
      loginPollRef.current = false;
      if (aliveRef.current) setLoggingIn(false);
    }
  }, [load]);

  const copyCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(LOGIN_COMMAND);
      if (!aliveRef.current) return;
      setCopied(true);
      setTimeout(() => {
        if (aliveRef.current) setCopied(false);
      }, 1500);
    } catch {
      // Clipboard denied (rare in this desktop context) — the command is shown
      // in full next to the button, so the user can still select it by hand.
    }
  }, []);

  // Absent field, or a build with no dev engine → render nothing at all rather
  // than an indicator for a capability this app does not have.
  if (!login || !login.relevant) return null;

  const status = login.status;
  const signedIn = status === 'signed-in';
  const dotClass = signedIn
    ? 'bg-emerald-500'
    : status === 'signed-out'
      ? 'bg-amber-500'
      : 'bg-muted-foreground/50';

  // Identity from `claude auth status`. The email is the primary identity now
  // that we have it; the plan tier rides alongside as a short chip.
  const email = login.account?.email ?? null;
  const orgName = login.account?.orgName ?? null;
  const subscription = login.account?.subscriptionType ?? null;
  const planLabel = subscription
    ? `${subscription.charAt(0).toUpperCase()}${subscription.slice(1)}`
    : null;

  // The chip's own label: the email when signed in and known, else a status word.
  const label = signedIn
    ? email ?? t('claudeAccount.signedIn', { defaultValue: 'Claude: signed in' })
    : status === 'signed-out'
      ? t('claudeAccount.signedOut', { defaultValue: 'Claude: signed out' })
      : t('claudeAccount.unknown', { defaultValue: 'Claude: unknown' });

  return (
    <span
      ref={rootRef}
      className="relative flex items-center gap-1.5 ml-2 pl-3 border-l border-border text-xs"
      data-testid="claude-login-status"
      data-status={status}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded hover:bg-accent px-1 py-0.5"
        data-testid="claude-account-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={login.summary}
      >
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`}
          data-testid="claude-login-dot"
        />
        <span
          className={status === 'signed-out' ? 'text-amber-500' : 'text-muted-foreground'}
          data-testid="claude-account-label"
        >
          {label}
        </span>
        {/* The plan label rides on the chip when signed in — short, non-secret. */}
        {signedIn && planLabel && (
          <span
            className="px-1 py-0.5 rounded bg-secondary text-foreground/80"
            data-testid="claude-account-plan"
          >
            {planLabel}
          </span>
        )}
      </button>

      {/* The remedy stays inline while signed out, not tooltip-only: a user who
          does not know they are signed out also does not know to hover. */}
      {login.remedy && !open && !signedIn && (
        <span className="text-muted-foreground" data-testid="claude-login-remedy">
          —{' '}
          <button
            type="button"
            onClick={() => void doLogin()}
            disabled={loggingIn}
            className="underline hover:text-foreground disabled:opacity-50"
            data-testid="claude-login-inline"
          >
            {loggingIn
              ? t('claudeAccount.waitingForBrowser', {
                  defaultValue: 'Waiting for browser sign-in…',
                })
              : t('claudeAccount.login', { defaultValue: 'Log in' })}
          </button>
        </span>
      )}

      {open && (
        <div
          role="menu"
          data-testid="claude-account-menu"
          className="absolute top-full left-0 mt-1 z-50 w-72 rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-3 flex flex-col gap-2"
        >
          {/* WHO — the real identity from `claude auth status`. */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {t('claudeAccount.account', { defaultValue: 'Account' })}
            </span>
            <span className="text-foreground" data-testid="claude-account-identity">
              {signedIn
                ? email ??
                  (planLabel
                    ? t('claudeAccount.planLine', { plan: planLabel, defaultValue: '{{plan}} plan' })
                    : t('claudeAccount.signedInNoPlan', { defaultValue: 'Signed in' }))
                : status === 'signed-out'
                  ? t('claudeAccount.notSignedIn', { defaultValue: 'Not signed in' })
                  : t('claudeAccount.statusUnknown', { defaultValue: 'Sign-in status unknown' })}
            </span>
            {/* Org + plan when signed in — the fuller identity the CLI reports. */}
            {signedIn && (orgName || planLabel) && (
              <span className="text-[11px] text-muted-foreground" data-testid="claude-account-org">
                {[orgName, planLabel ? t('claudeAccount.planLine', { plan: planLabel, defaultValue: '{{plan}} plan' }) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
            <span className="text-[11px] text-muted-foreground">{login.summary}</span>
          </div>

          <div className="border-t border-border" />

          {/* WHAT YOU CAN DO — depends on the current state. */}
          {signedIn ? (
            <button
              type="button"
              onClick={() => void logout()}
              disabled={busy}
              data-testid="claude-account-logout"
              className="text-left px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-50"
            >
              {busy
                ? t('claudeAccount.loggingOut', { defaultValue: 'Signing out…' })
                : t('claudeAccount.logout', { defaultValue: 'Log out' })}
            </button>
          ) : (
            <div className="flex flex-col gap-1.5">
              {/* Primary action: launch the browser OAuth flow from the app. */}
              <button
                type="button"
                onClick={() => void doLogin()}
                disabled={loggingIn}
                data-testid="claude-account-login"
                className="text-left px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-50"
              >
                {loggingIn
                  ? t('claudeAccount.waitingForBrowser', {
                      defaultValue: 'Waiting for browser sign-in…',
                    })
                  : t('claudeAccount.login', { defaultValue: 'Log in' })}
              </button>
              {loginError && (
                <span className="text-[11px] text-amber-500" data-testid="claude-account-login-error">
                  {loginError}
                </span>
              )}
              {/* Fallback: the exact command, for a headless box where no browser
                  can open, or if the spawn was refused. */}
              <span className="text-[11px] text-muted-foreground">
                {t('claudeAccount.orRunInTerminal', {
                  defaultValue: 'Or run this in a terminal, then re-check:',
                })}
              </span>
              <div className="flex items-center gap-1">
                <code className="flex-1 px-2 py-1 rounded bg-secondary text-foreground">
                  {LOGIN_COMMAND}
                </code>
                <button
                  type="button"
                  onClick={() => void copyCommand()}
                  data-testid="claude-account-copy"
                  className="px-2 py-1 rounded border border-border hover:bg-accent"
                >
                  {copied
                    ? t('claudeAccount.copied', { defaultValue: 'Copied' })
                    : t('claudeAccount.copy', { defaultValue: 'Copy' })}
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => void recheck()}
            disabled={rechecking}
            data-testid="claude-login-recheck"
            className="text-left px-2 py-1 rounded border border-border text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            {rechecking
              ? t('claudeAccount.checking', { defaultValue: 'Checking…' })
              : t('claudeAccount.recheck', { defaultValue: 'Re-check' })}
          </button>
        </div>
      )}
    </span>
  );
}
