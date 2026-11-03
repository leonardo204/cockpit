'use client';

/**
 * THE CLAUDE SIGN-IN, READ FROM ONE PLACE — the account chip's requests and
 * poll (ClaudeLoginStatus), and the status it reads, published for the guide
 * card a failed turn shows (ClaudeReloginCard, specs/claude-relogin-guide.md R4).
 *
 * If the card kept its own fetch and its own idea of "signed in", it could tick
 * a step the chip still showed undone (CLAUDE.md: no second copy of a verdict).
 * So the chip reads, and the card follows what the chip read.
 *
 * WHAT THE SERVER ALREADY DOES. `claude.login` / `claude.logout` act on the
 * SELECTED account's namespace when one is selected, and the `claudeLogin`
 * block on GET /api/naby describes that same account (api/naby.ts). Nothing
 * here resolves accounts; it only decides the order of the calls.
 *
 * THE STATUS IS PUBLISHED from the chip's reads to a tiny per-frame store, which
 * the guide card follows to tick its steps off (`reloginProgress`). The card is
 * guidance only: the user logs out and in on the chip themselves.
 *
 * NO SECRETS. Everything read here is identity labels and a status word.
 */

export type ClaudeAccount = {
  /** The signed-in account's email, from `claude auth status`. */
  email: string | null;
  /** The organisation name, when reported. */
  orgName: string | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
};

export type ClaudeLogin = {
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

/** One Claude subscription naby keeps, as `/api/naby` describes it. An OPAQUE id
 *  and identity labels — never a path (claude-multi-account §5.6). `emailHint` is
 *  the identity read straight from the account's own file, so a row shows WHO it
 *  is before a `verify` has confirmed it and written `email` back. */
export type ClaudeAccountRow = {
  id: string;
  email: string | null;
  emailHint: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  status: 'signed-in' | 'signed-out' | 'unknown' | string;
};

/** The account block that rides along on every `/api/naby` GET. Absent from an
 *  older server, which reads as "one account" and hides the switcher. */
export type ClaudeAccountsBlock = {
  /** False when this computer cannot keep sign-ins apart (§5.3) — the switcher
   *  then does not appear, exactly as the settings card hides its section. */
  supported: boolean;
  /** null = "this computer's own sign-in", i.e. single-account behaviour. */
  activeId: string | null;
  accounts: ClaudeAccountRow[];
  /** The machine's own sign-in identity, read from its file so the default row
   *  can name WHO it is rather than only "this computer". */
  machineDefault: { email: string | null; orgName: string | null; subscriptionType: string | null } | null;
};

/** What one GET of /api/naby says about Claude. Either part may be missing on an
 *  older server; a caller renders nothing for what it did not get. */
export type ClaudeLoginState = {
  login: ClaudeLogin | null;
  accounts: ClaudeAccountsBlock | null;
};

/** The interactive login poll: after launching the browser flow, re-check status
 *  every this-often, giving up after `LOGIN_POLL_MAX` tries (~60s total). */
export const LOGIN_POLL_MS = 2_000;
export const LOGIN_POLL_MAX = 30;

/** The exact command a signed-out user runs, and the copy-paste fallback for a
 *  headless machine. One string so every button and hint cannot drift apart. */
export const LOGIN_COMMAND = 'claude auth login';

/**
 * Read the sign-in. `force` bypasses the runtime's 10s cache (`recheckLogin`) —
 * only a user action or a login poll should pay for a fresh `claude auth status`.
 * Null when the request failed: a failed read keeps the caller's last answer.
 */
export async function fetchClaudeLoginState(force = false): Promise<ClaudeLoginState | null> {
  try {
    const res = await fetch(`/api/naby${force ? '?recheckLogin=1' : ''}`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      claudeLogin?: ClaudeLogin;
      claudeAccounts?: ClaudeAccountsBlock;
    };
    return { login: data.claudeLogin ?? null, accounts: data.claudeAccounts ?? null };
  } catch {
    return null;
  }
}

async function postNaby(body: Record<string, unknown>): Promise<Response> {
  return fetch('/api/naby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Sign out of the selected account (`claude auth logout` server-side). The
 * runtime resets its login cache, so a forced re-check right after reflects the
 * signed-out truth. False on any failure.
 */
export async function claudeLogout(): Promise<boolean> {
  try {
    const res = await postNaby({ action: 'claude.logout' });
    return res.ok;
  } catch {
    return false;
  }
}

export type StartLoginResult =
  | { ok: true }
  | {
      ok: false;
      /** The server's reason, short form preferred; null when it said nothing
       *  (the caller supplies its own wording). */
      error: string | null;
      /** Set only when the refusal was "no CLI here". */
      docsUrl: string | null;
    };

/**
 * Launch the browser OAuth flow for the selected account (`claude auth login`,
 * spawned detached server-side). Returns once it has STARTED — the sign-in
 * itself is detected by polling.
 */
export async function startClaudeLogin(): Promise<StartLoginResult> {
  try {
    const res = await postNaby({ action: 'claude.login' });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      errorHeadline?: string;
      installHelp?: { docsUrl?: string } | null;
    } | null;
    // PREFER THE HEADLINE. "Claude Code is not installed" arrives as a
    // four-sentence paragraph — the right length for the settings card that
    // shows the install commands, and a wall of text in a chip popover. The
    // server sends the first sentence beside it for exactly this spot, and the
    // docs link carries the rest.
    return {
      ok: false,
      error: body?.errorHeadline ?? body?.error ?? null,
      docsUrl: body?.installHelp?.docsUrl ?? null,
    };
  } catch {
    return { ok: false, error: null, docsUrl: null };
  }
}

/** Re-read one kept account's identity (`claude auth status` in its namespace),
 *  so its row in the account block reflects a sign-in that just landed. */
export async function verifyClaudeAccount(accountId: string): Promise<void> {
  await postNaby({ action: 'claude-account.verify', accountId }).catch(() => undefined);
}

/**
 * Poll until `check` says the sign-in landed: every `LOGIN_POLL_MS`, at most
 * `LOGIN_POLL_MAX` tries (~60s), stopping early when `isLive` turns false (the
 * user cancelled, or the component unmounted). Resolves to whether it landed.
 */
export async function pollClaudeSignIn(
  check: () => Promise<boolean>,
  isLive: () => boolean,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  for (let i = 0; i < LOGIN_POLL_MAX && isLive(); i++) {
    if (await check()) return true;
    if (!isLive()) return false;
    await sleep(LOGIN_POLL_MS);
  }
  return false;
}

// — ONE STATUS, TWO READERS (specs/claude-relogin-guide.md R3–R4) ——————————

/**
 * The sign-in status the chip last read, for anything else in this frame that
 * has to follow it — the guide card under a failed turn ticks its steps off as
 * the status moves. The chip is the ONLY writer: it already re-reads after its
 * own log out / log in and on its background poll, so the card never polls,
 * never calls an action, and can never disagree with what the chip shows.
 *
 * Module scope, so it is per frame. The chip and the card are both rendered by
 * the same <Chat/>, which is in one frame, so they always share it.
 */
let publishedStatus: string | null = null;
const statusListeners = new Set<() => void>();

/** The chip reports what it just read. Unchanged values notify nobody. */
export function publishClaudeLoginStatus(status: string | null): void {
  if (status === publishedStatus) return;
  publishedStatus = status;
  for (const l of statusListeners) l();
}

/** The status the chip last read, or null before its first read. */
export function getClaudeLoginStatus(): string | null {
  return publishedStatus;
}

/** Subscribe to status changes (useSyncExternalStore's contract). */
export function subscribeClaudeLoginStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

/** How far the user has got through the guide card's log out → log in steps. */
export interface ReloginProgress {
  /** Step 2 done: the status read signed out. */
  readonly loggedOut: boolean;
  /** Step 3 done: signed in again, AFTER the logout. */
  readonly signedInAgain: boolean;
}

export const RELOGIN_START: ReloginProgress = { loggedOut: false, signedInAgain: false };

/**
 * Fold one status reading into the progress. Display only — nothing here
 * decides anything for the user.
 *
 *   signed-out             → step 2 ✓ (a card that opens signed out starts here)
 *   signed-in after that   → step 3 ✓
 *   signed-in before that  → nothing: an expired refresh still reads signed in,
 *                            so it is not a new sign-in
 *
 * Finished steps stay finished. Returns the same object when nothing changed.
 */
export function reloginProgress(prev: ReloginProgress, status: string | null | undefined): ReloginProgress {
  if (status === 'signed-out') {
    return prev.loggedOut ? prev : { loggedOut: true, signedInAgain: false };
  }
  if (status === 'signed-in' && prev.loggedOut && !prev.signedInAgain) {
    return { loggedOut: true, signedInAgain: true };
  }
  return prev;
}

// — THE CHIP HIGHLIGHT WHILE THE GUIDE IS UP (specs/claude-relogin-guide.md R3a) —

/**
 * What the guide card tells the chip beside it. One per <Chat/> — the chip and
 * the card of the SAME conversation share it, so a guide in one tab never lights
 * up another tab's chip. The card is the only writer of `active` / `loggedOut`;
 * the two request counters are edges the chip reacts to (open the menu, flash
 * the ring once). Nothing here reads the sign-in: progress still comes from the
 * status the chip publishes, folded by the card.
 */
export interface ReloginGuideState {
  /** A guide card is up and the sign-in is not back yet → the chip pulses. */
  readonly active: boolean;
  /** Step 2 is done → the item to press next is Log in, not Log out. */
  readonly loggedOut: boolean;
  /** Bumped when the user clicks "Claude chip" in step 1 → open the menu. */
  readonly openRequest: number;
  /** Bumped when the user hovers it → flash the ring once. */
  readonly flashRequest: number;
}

export const RELOGIN_GUIDE_IDLE: ReloginGuideState = { active: false, loggedOut: false, openRequest: 0, flashRequest: 0 };

export interface ReloginGuide {
  get: () => ReloginGuideState;
  subscribe: (listener: () => void) => () => void;
  /** The card reports where the user is. Unchanged values notify nobody. */
  report: (next: { active: boolean; loggedOut: boolean }) => void;
  requestOpen: () => void;
  requestFlash: () => void;
}

export function createReloginGuide(): ReloginGuide {
  let state = RELOGIN_GUIDE_IDLE;
  const listeners = new Set<() => void>();
  const set = (next: ReloginGuideState) => {
    state = next;
    for (const l of listeners) l();
  };
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    report: ({ active, loggedOut }) => {
      if (state.active === active && state.loggedOut === loggedOut) return;
      set({ ...state, active, loggedOut });
    },
    requestOpen: () => set({ ...state, openRequest: state.openRequest + 1 }),
    requestFlash: () => set({ ...state, flashRequest: state.flashRequest + 1 }),
  };
}

/**
 * Where the chip draws attention, given the guide and whether its menu is open.
 *
 *   ring        pulse around the chip — while the guide is active and the menu
 *               is CLOSED (an open menu is already where the eye is)
 *   logout      outline on Log out — menu open, step 2 not done yet
 *   login       outline on Log in — step 2 done (in the menu, or the inline
 *               "Log in" beside the chip once it reads signed out)
 */
export function chipHighlight(
  guide: Pick<ReloginGuideState, 'active' | 'loggedOut'>,
  menuOpen: boolean,
): { ring: boolean; logout: boolean; login: boolean } {
  if (!guide.active) return { ring: false, logout: false, login: false };
  return { ring: !menuOpen, logout: menuOpen && !guide.loggedOut, login: guide.loggedOut };
}
