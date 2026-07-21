'use client';

/**
 * The Claude account chip — sign-in status PLUS an account menu.
 *
 * WHY IT LIVES HERE. The dev engine answers on the local Claude sign-in, and
 * the execution-mode row is the one place the user is already looking at that
 * choice. A sign-in warning anywhere else is a warning found only after the
 * failure it exists to prevent.
 *
 * WHAT THE CHIP SHOWS:
 *   ● Signed in    green   nothing to do — click for the account menu
 *   ● Signed out   amber   PLUS the fix inline (`claude login`), because the
 *                          whole point is the user does not yet know what to do.
 *                          Amber not red: nothing has failed, and a red alarm on
 *                          a working app trains people to ignore red.
 *   ● Unknown      muted   we could not tell. Says so rather than guessing.
 *
 * THE ACCOUNT MENU (click the chip). Opens a small popover with:
 *   * WHICH account — as much as the credential file honestly carries. That file
 *     has NO email and NO account id; its only identity field is the SUBSCRIPTION
 *     tier (e.g. "Max"). We show that and never fabricate an email.
 *   * Log out — removes the OAuth credential file via /api/naby (`claude.logout`)
 *     and re-checks, so the chip flips to signed-out immediately.
 *   * Log in — `claude login` is an INTERACTIVE terminal/browser OAuth flow the
 *     app cannot drive silently. So the honest, robust thing: show the exact
 *     command with a Copy button and a Re-check. The user runs it in their
 *     terminal; the app picks up the new state on Re-check (or window focus).
 *
 * IT NEVER BLOCKS ANYTHING. Sending stays enabled while signed out: the check is
 * a heuristic over a credential file, and an app that refuses to send because
 * its heuristic is wrong is worse than one that lets the send fail with a clear
 * error. This is advice, not a gate.
 *
 * NO SECRETS. Everything here comes from /api/naby's `claudeLogin` block, built
 * by the runtime from two expiry timestamps plus non-secret subscription labels.
 * No field on the wire could carry credential material, and Log out DELETES the
 * credential file without ever reading it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type ClaudeAccount = {
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
  /** Who is signed in, to the extent the file says so. NEVER an email. */
  account?: ClaudeAccount | null;
};

/** Deliberately unhurried: this covers only "the token expired while the user
 *  sat here", which takes hours. Focus is what catches a fresh `claude login`. */
const POLL_MS = 60_000;

/** The exact command a signed-out user runs. One string, reused for the copy
 *  button and the inline hint so they can never drift apart. */
const LOGIN_COMMAND = 'claude login';

export function ClaudeLoginStatus() {
  const { t } = useTranslation();
  const [login, setLogin] = useState<ClaudeLogin | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // Guards against a state update on an unmounted component when a tab is
  // closed mid-request — every chat tab mounts one of these.
  const aliveRef = useRef(true);
  const rootRef = useRef<HTMLSpanElement>(null);

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
      // Whether it reported removed:true or "already gone", the truth is on disk
      // now — a forced re-check reflects it (the runtime reset its cache on
      // logout, so this is not racing a stale 10s answer).
      if (res.ok) await load(true);
    } catch {
      // Leave the menu open on failure so the user can retry; the next re-check
      // or focus still corrects the displayed state.
    } finally {
      if (aliveRef.current) setBusy(false);
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
  const label = signedIn
    ? t('claudeAccount.signedIn', { defaultValue: 'Claude: signed in' })
    : status === 'signed-out'
      ? t('claudeAccount.signedOut', { defaultValue: 'Claude: signed out' })
      : t('claudeAccount.unknown', { defaultValue: 'Claude: unknown' });

  // The subscription tier is the ONLY identity the credential file carries.
  // Presented as "Max plan" when present; there is deliberately no email.
  const subscription = login.account?.subscriptionType ?? null;
  const planLabel = subscription
    ? `${subscription.charAt(0).toUpperCase()}${subscription.slice(1)}`
    : null;

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
        <span className={status === 'signed-out' ? 'text-amber-500' : 'text-muted-foreground'}>
          {label}
        </span>
        {/* The plan label rides on the chip when signed in — it is the account
            identity, short and non-secret. */}
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
      {login.remedy && !open && (
        <span className="text-muted-foreground" data-testid="claude-login-remedy">
          — {t('claudeAccount.runInTerminal', { defaultValue: 'run' })}{' '}
          <code className="px-1 py-0.5 rounded bg-secondary text-foreground">{LOGIN_COMMAND}</code>{' '}
          {t('claudeAccount.inATerminal', { defaultValue: 'in a terminal' })}
        </span>
      )}

      {open && (
        <div
          role="menu"
          data-testid="claude-account-menu"
          className="absolute top-full left-0 mt-1 z-50 w-72 rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-3 flex flex-col gap-2"
        >
          {/* WHO — identity to the extent the file says so. */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {t('claudeAccount.account', { defaultValue: 'Account' })}
            </span>
            <span className="text-foreground" data-testid="claude-account-identity">
              {signedIn
                ? planLabel
                  ? t('claudeAccount.planLine', {
                      plan: planLabel,
                      defaultValue: '{{plan}} plan',
                    })
                  : t('claudeAccount.signedInNoPlan', { defaultValue: 'Signed in' })
                : status === 'signed-out'
                  ? t('claudeAccount.notSignedIn', { defaultValue: 'Not signed in' })
                  : t('claudeAccount.statusUnknown', { defaultValue: 'Sign-in status unknown' })}
            </span>
            {/* Honesty note: no email exists in the credential, so we say what
                the identity is rather than imply there is more. */}
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
              {/* Login is an interactive OAuth flow the app cannot run silently.
                  The honest, robust path: show the command + copy it; the user
                  runs it in a terminal and re-checks. */}
              <span className="text-[11px] text-muted-foreground">
                {t('claudeAccount.loginInstructions', {
                  defaultValue: 'Run this in a terminal, then re-check:',
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
