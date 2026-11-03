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
 * WHAT IT READS IS PUBLISHED (claudeLoginFlow.ts) for the guide card a failed
 * turn shows, which ticks its log out → log in steps off as this chip's own
 * re-reads move the status. The chip is the one reader of the sign-in; the card
 * never asks on its own.
 *
 * IT NEVER BLOCKS ANYTHING. Sending stays enabled while signed out: an app that
 * refuses to send because its status probe is wrong is worse than one that lets
 * the send fail with a clear error. This is advice, not a gate.
 *
 * NO SECRETS. Everything here comes from /api/naby's `claudeLogin` block, built
 * by the runtime from `claude auth status` — identity LABELS (email, org, plan)
 * and a status word, never token material.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LOGIN_COMMAND,
  RELOGIN_GUIDE_IDLE,
  chipHighlight,
  claudeLogout,
  fetchClaudeLoginState,
  pollClaudeSignIn,
  publishClaudeLoginStatus,
  startClaudeLogin,
  verifyClaudeAccount,
  type ClaudeAccountsBlock,
  type ClaudeLogin,
  type ReloginGuide,
} from './claudeLoginFlow';

/** Deliberately unhurried background poll: this covers only "the token expired
 *  while the user sat here", which takes hours. Focus + the login poll catch a
 *  fresh sign-in far sooner. */
const POLL_MS = 60_000;

/** How long the one-off "here I am" flash lasts — matches its keyframe. */
const FLASH_MS = 700;

const noGuideSubscribe = () => () => {};
const noGuideSnapshot = () => RELOGIN_GUIDE_IDLE;

/** The outline on the menu item the re-login guide says to press next (R3a). */
const GUIDE_OUTLINE = 'ring-2 ring-brand';

interface ClaudeLoginStatusProps {
  /** This conversation's re-login guide (specs/claude-relogin-guide.md R3a).
   *  While its card is up the chip pulses, and the item to press next is
   *  outlined. Absent → the chip is exactly as it always was. */
  guide?: ReloginGuide;
}

export function ClaudeLoginStatus({ guide }: ClaudeLoginStatusProps = {}) {
  const { t } = useTranslation();
  const [login, setLogin] = useState<ClaudeLogin | null>(null);
  // The account list, from the same GET. Drives the switcher; null on an older
  // server, which correctly shows no switcher.
  const [accounts, setAccounts] = useState<ClaudeAccountsBlock | null>(null);
  // A calm, non-error note shown after a mid-turn switch: the new account answers
  // from the NEXT turn (claude-multi-account §5.4). Cleared on the next action.
  const [switchInfo, setSwitchInfo] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  /** Set only when the refusal was "no CLI here" — the one failure this popover
   *  cannot fully explain on its own. */
  const [loginDocsUrl, setLoginDocsUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Guards against a state update on an unmounted component when a tab is
  // closed mid-request — every chat tab mounts one of these.
  const aliveRef = useRef(true);
  const rootRef = useRef<HTMLSpanElement>(null);
  // A login poll in flight, so a second click (or unmount) can cancel it.
  const loginPollRef = useRef(false);
  // The latest account block, read inside the add-account poll without a stale
  // closure over `accounts`.
  const accountsRef = useRef<ClaudeAccountsBlock | null>(null);
  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  // — R3a: the re-login guide's highlight. Read, never written: the card under
  // the failed turn decides whether it is up and which step the user is on.
  const guideState = useSyncExternalStore(
    guide?.subscribe ?? noGuideSubscribe,
    guide?.get ?? noGuideSnapshot,
    guide?.get ?? noGuideSnapshot,
  );
  const highlight = chipHighlight(guideState, open);
  // Step 1's "Claude chip" was clicked → open the menu. An edge, so the value
  // the chip mounted with is not a request.
  const openSeenRef = useRef(guideState.openRequest);
  useEffect(() => {
    if (guideState.openRequest === openSeenRef.current) return;
    openSeenRef.current = guideState.openRequest;
    setOpen(true);
  }, [guideState.openRequest]);
  // …hovered → flash the ring once.
  const [flashing, setFlashing] = useState(false);
  const flashSeenRef = useRef(guideState.flashRequest);
  useEffect(() => {
    if (guideState.flashRequest === flashSeenRef.current) return;
    flashSeenRef.current = guideState.flashRequest;
    setFlashing(true);
    const id = setTimeout(() => setFlashing(false), FLASH_MS);
    return () => clearTimeout(id);
  }, [guideState.flashRequest]);

  // Returns the freshly-fetched login so callers (the login poll) can inspect it
  // without waiting for React state to settle.
  const load = useCallback(async (force = false): Promise<ClaudeLogin | null> => {
    const data = await fetchClaudeLoginState(force);
    // A failed poll keeps the last known answer. The send path surfaces any
    // real failure with a far better message than a status dot could.
    if (!data) return null;
    // An older server (or a build without the runtime) simply omits the
    // field; rendering nothing is the correct degradation.
    if (aliveRef.current && data.login) setLogin(data.login);
    // …and the guide card under a failed turn follows the same reading.
    if (data.login) publishClaudeLoginStatus(data.login.status);
    // The account block rides on the same poll (a settings read, no process),
    // so the switcher stays current at no extra cost.
    if (aliveRef.current) setAccounts(data.accounts);
    return data.login;
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
      // The runtime reset its cache on logout, so a forced re-check reflects the
      // new (signed-out) truth rather than a stale 10s "signed in". On failure
      // the menu stays open so the user can retry; the next re-check or focus
      // still corrects the displayed state.
      if (await claudeLogout()) await load(true);
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [load]);

  // Log in: launch the browser OAuth flow server-side, then poll status until it
  // flips to signed-in. The server does not block on the user, so neither do we —
  // we poll and let the chip update the moment the sign-in lands.
  const doLogin = useCallback(async () => {
    setLoginError(null);
    setLoginDocsUrl(null);
    setLoggingIn(true);
    loginPollRef.current = true;
    try {
      const started = await startClaudeLogin();
      if (!started.ok) {
        if (aliveRef.current) {
          // The command is shown for copy-paste, so a spawn failure (headless /
          // no CLI) is recoverable by the user.
          setLoginError(started.error ?? 'Could not start sign-in.');
          setLoginDocsUrl(started.docsUrl);
          setLoggingIn(false);
        }
        loginPollRef.current = false;
        return;
      }
      // Poll `claude auth status` until the OAuth callback completes.
      await pollClaudeSignIn(
        async () => (await load(true))?.status === 'signed-in',
        () => loginPollRef.current && aliveRef.current,
      );
    } catch {
      if (aliveRef.current) setLoginError('Could not start sign-in.');
    } finally {
      loginPollRef.current = false;
      if (aliveRef.current) setLoggingIn(false);
    }
  }, [load]);

  // Switch which Claude account answers. Accepted even mid-turn (§5.4): the reply
  // carries `appliesNextTurn`, and if so we say the new account answers from the
  // next turn rather than pretending it is already live. `id` is '' for the
  // machine's own sign-in — the way back to single-account behaviour.
  const switchAccount = useCallback(
    async (id: string) => {
      setBusy(true);
      setSwitchInfo(null);
      try {
        const res = await fetch('/api/naby', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'claude-account.select', accountId: id }),
        });
        const body = (await res.json().catch(() => null)) as {
          ok?: boolean;
          appliesNextTurn?: boolean;
        } | null;
        // Cache was reset server-side; a forced re-check reflects the newly
        // selected account's identity rather than a 10s-stale answer.
        if (res.ok) await load(true);
        if (aliveRef.current && body?.appliesNextTurn) {
          setSwitchInfo(t('claudeAccount.appliesNextTurn'));
        }
      } catch {
        // Leave the menu open so the user can retry; the next re-check corrects
        // whatever the display shows.
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [load, t],
  );

  // Add a brand-new account: mint the namespace and launch its browser sign-in,
  // then poll until the sign-in lands (same contract as `doLogin`). This is how a
  // user logs in a SECOND account without leaving the chat bar.
  const addAccount = useCallback(async () => {
    setLoginError(null);
    setLoginDocsUrl(null);
    setSwitchInfo(null);
    setLoggingIn(true);
    loginPollRef.current = true;
    try {
      const res = await fetch('/api/naby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claude-account.add' }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        accountId?: string;
        error?: string;
        errorHeadline?: string;
        errorKey?: string;
        installHelp?: { docsUrl?: string } | null;
      } | null;
      if (!res.ok || !body?.accountId) {
        if (aliveRef.current) {
          setLoginError(
            body?.errorKey
              ? t(body.errorKey)
              : (body?.errorHeadline ?? body?.error ?? t('claudeAccount.login')),
          );
          setLoginDocsUrl(body?.installHelp?.docsUrl ?? null);
          setLoggingIn(false);
        }
        loginPollRef.current = false;
        return;
      }
      const accountId = body.accountId;
      await load(true);
      // Poll that account's own namespace until the OAuth callback completes.
      await pollClaudeSignIn(
        async () => {
          await verifyClaudeAccount(accountId);
          await load(true);
          return accountsRef.current?.accounts.find((a) => a.id === accountId)?.status === 'signed-in';
        },
        () => loginPollRef.current && aliveRef.current,
      );
    } catch {
      if (aliveRef.current) setLoginError(t('claudeAccount.login'));
    } finally {
      loginPollRef.current = false;
      if (aliveRef.current) setLoggingIn(false);
    }
  }, [load, t]);

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
    ? 'bg-success'
    : status === 'signed-out'
      ? 'bg-warning'
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
        // The ring is a box-shadow (globals.css): it draws outside the box, so
        // the chip neither moves nor resizes while it pulses.
        className={`flex items-center gap-1.5 rounded hover:bg-accent px-1 py-0.5${
          highlight.ring ? ' claude-chip-guide' : ''
        }${flashing ? ' claude-chip-guide-flash' : ''}`}
        data-guide={highlight.ring ? 'pulse' : undefined}
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
          className={status === 'signed-out' ? 'text-warning' : 'text-muted-foreground'}
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
            className={`underline hover:text-foreground disabled:opacity-50 rounded${
              highlight.login ? ` px-1 ${GUIDE_OUTLINE}` : ''
            }`}
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
          className="absolute top-full left-0 mt-1 z-50 w-80 max-h-[70vh] overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-3 flex flex-col gap-2"
        >
          {/* WHO — the real identity from `claude auth status`. */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[0.786rem] uppercase tracking-wide text-muted-foreground">
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
              <span className="text-[0.786rem] text-muted-foreground" data-testid="claude-account-org">
                {[orgName, planLabel ? t('claudeAccount.planLine', { plan: planLabel, defaultValue: '{{plan}} plan' }) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
            <span className="text-[0.786rem] text-muted-foreground">{login.summary}</span>
          </div>

          <div className="border-t border-border" />

          {/* SWITCH ACCOUNT — only where this machine can keep sign-ins apart
              (§5.3). Selecting is accepted even mid-turn; §5.4's lag is disclosed
              by `switchInfo`, never refused. Adding an account is how a user
              signs a SECOND account in from the chat bar itself. */}
          {accounts?.supported && (
            <>
              {accounts.accounts.length > 0 && (
                <div className="flex flex-col gap-1" data-testid="claude-account-switcher">
                  <span className="text-[0.786rem] uppercase tracking-wide text-muted-foreground">
                    {t('claudeAccount.switchAccount')}
                  </span>
                  {[
                    {
                      id: '',
                      active: accounts.activeId === null,
                      main: accounts.machineDefault?.email ?? t('claudeAccount.machineDefault'),
                      sub: accounts.machineDefault?.email ? t('claudeAccount.machineDefault') : null,
                    },
                    ...accounts.accounts.map((a) => ({
                      id: a.id,
                      active: accounts.activeId === a.id,
                      main: a.email ?? a.emailHint ?? t('claudeAccount.notSignedIn'),
                      sub:
                        a.status !== 'signed-in'
                          ? t('claudeAccount.signInNeeded')
                          : (a.orgName ?? null),
                    })),
                  ].map((row) => (
                    <button
                      key={row.id || 'machine-default'}
                      type="button"
                      onClick={() => void switchAccount(row.id)}
                      disabled={busy || row.active}
                      data-testid={`claude-account-switch-${row.id || 'default'}`}
                      className={`text-left px-2 py-1 rounded border transition-colors disabled:cursor-default ${
                        row.active
                          ? 'border-brand bg-brand/5'
                          : 'border-border hover:bg-accent disabled:opacity-50'
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-foreground">{row.main}</span>
                        {row.active && (
                          <span className="shrink-0 text-[0.786rem] text-brand">
                            {t('claudeAccount.active')}
                          </span>
                        )}
                      </span>
                      {row.sub && (
                        <span className="block truncate text-[0.786rem] text-muted-foreground">
                          {row.sub}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {switchInfo && (
                <span
                  className="text-[0.786rem] text-muted-foreground"
                  data-testid="claude-account-switch-info"
                >
                  {switchInfo}
                </span>
              )}

              <button
                type="button"
                onClick={() => void addAccount()}
                disabled={loggingIn || busy}
                data-testid="claude-account-add"
                className="text-left px-2 py-1 rounded border border-border text-muted-foreground hover:bg-accent disabled:opacity-50"
              >
                {loggingIn
                  ? t('claudeAccount.waitingForBrowser', {
                      defaultValue: 'Waiting for browser sign-in…',
                    })
                  : t('claudeAccount.addAccount')}
              </button>

              <div className="border-t border-border" />
            </>
          )}

          {/* WHAT YOU CAN DO — depends on the current state. */}
          {signedIn ? (
            <button
              type="button"
              onClick={() => void logout()}
              disabled={busy}
              data-testid="claude-account-logout"
              className={`text-left px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-50${
                highlight.logout ? ` ${GUIDE_OUTLINE}` : ''
              }`}
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
                className={`text-left px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-50${
                  highlight.login ? ` ${GUIDE_OUTLINE}` : ''
                }`}
              >
                {loggingIn
                  ? t('claudeAccount.waitingForBrowser', {
                      defaultValue: 'Waiting for browser sign-in…',
                    })
                  : t('claudeAccount.login', { defaultValue: 'Log in' })}
              </button>
              {loginError && (
                <span className="text-[0.786rem] text-warning" data-testid="claude-account-login-error">
                  {loginError}
                  {loginDocsUrl && (
                    <>
                      {' '}
                      <a
                        href={loginDocsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                        data-testid="claude-account-install-docs"
                      >
                        {t('claudeAccount.installGuide', { defaultValue: 'How to install' })}
                      </a>
                    </>
                  )}
                </span>
              )}
              {/* Fallback: the exact command, for a headless box where no browser
                  can open, or if the spawn was refused. */}
              <span className="text-[0.786rem] text-muted-foreground">
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
