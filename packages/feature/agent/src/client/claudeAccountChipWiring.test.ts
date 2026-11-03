import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The chat-bar Claude chip has to let you SWITCH accounts and SIGN IN a second
 * one, not only report the active one.
 *
 * These are source-string checks for the same reason the background-job wiring
 * test is: jsdom cannot see the chip's popover open against a live `/api/naby`,
 * and the failure being guarded is "the wire was never connected" — the switcher
 * silently absent, or a button pointing at the wrong action — which a pure
 * render test would pass right through.
 */

const CLIENT = __dirname;
const read = (name: string) => readFileSync(join(CLIENT, name), 'utf8');

describe('claude account chip — account switching wiring', () => {
  const src = read('ClaudeLoginStatus.tsx');
  // The reads, actions and poll the chip shares with the re-login card
  // (specs/claude-relogin-guide.md R4).
  const flow = read('claudeLoginFlow.ts');

  it('reads the account block from the same GET the chip already polls', () => {
    expect(flow).toContain('claudeAccounts?: ClaudeAccountsBlock');
    expect(flow).toContain('accounts: data.claudeAccounts ?? null');
    expect(src).toContain('const data = await fetchClaudeLoginState(force);');
    expect(src).toContain('setAccounts(data.accounts)');
  });

  it('offers the switcher only where the machine can keep sign-ins apart (§5.3)', () => {
    // The whole block is gated on `supported`; on a machine that cannot isolate
    // sign-ins it must not appear, exactly as the settings card hides its card.
    expect(src).toContain('accounts?.supported &&');
    expect(src).toContain("data-testid=\"claude-account-switcher\"");
  });

  it('switches via claude-account.select and discloses the mid-turn lag (§5.4)', () => {
    expect(src).toContain("action: 'claude-account.select'");
    // Accept-and-disclose: the reply's appliesNextTurn becomes a calm note, not
    // an error or a refusal.
    expect(src).toContain('body?.appliesNextTurn');
    expect(src).toContain("t('claudeAccount.appliesNextTurn')");
    // Each row (the machine default among them) selects by its id; the machine
    // default's id is '' — the way back to single-account behaviour.
    expect(src).toContain('void switchAccount(row.id)');
    expect(src).toMatch(/id:\s*'',\s*\n\s*active: accounts\.activeId === null/);
  });

  it('signs a second account in from the chip via claude-account.add, then polls', () => {
    expect(src).toContain("action: 'claude-account.add'");
    expect(flow).toContain("action: 'claude-account.verify'");
    expect(src).toContain('await verifyClaudeAccount(accountId);');
    expect(src).toContain("data-testid=\"claude-account-add\"");
  });

  it('names WHO each row is, preferring the confirmed email then the file hint', () => {
    // A row must never fall back to the opaque id or a path — email, else the
    // identity-file hint, else a neutral placeholder.
    expect(src).toContain('a.email ?? a.emailHint ?? t');
    // The machine default row shows its own email when the file has one.
    expect(src).toContain('accounts.machineDefault?.email');
  });
});

describe('claude account chip — the one reader of the sign-in (claude-relogin-guide R3–R4)', () => {
  const src = read('ClaudeLoginStatus.tsx');
  const card = read('ClaudeReloginCard.tsx');

  it('drives log in / log out / the poll through claudeLoginFlow, with no copy of its own', () => {
    expect(src).toMatch(/from '\.\/claudeLoginFlow'/);
    expect(src).toContain('await startClaudeLogin()');
    expect(src).toContain('await claudeLogout()');
    expect(src).toContain('await pollClaudeSignIn(');
    expect(src).not.toContain("action: 'claude.login'");
    expect(src).not.toContain("action: 'claude.logout'");
    expect(src).not.toContain('recheckLogin=1');
    expect(src).not.toMatch(/const LOGIN_POLL_(MS|MAX) =/);
  });

  it('publishes every reading it makes, so the guide card follows the same value', () => {
    const load = src.slice(src.indexOf('const load = useCallback('), src.indexOf('}, []);', src.indexOf('const load = useCallback(')));
    expect(load).toContain('if (data.login) publishClaudeLoginStatus(data.login.status);');
  });

  it('the guide card only SUBSCRIBES — no fetch, no poll, no log out / log in', () => {
    expect(card).toContain('useSyncExternalStore(subscribeClaudeLoginStatus, getClaudeLoginStatus, getClaudeLoginStatus)');
    for (const forbidden of [
      'fetch(',
      'claude.login',
      'claude.logout',
      'claude-account.',
      'claudeLogout',
      'startClaudeLogin',
      'verifyClaudeAccount',
      'fetchClaudeLoginState',
      'pollClaudeSignIn',
      'setInterval',
    ]) {
      expect(card, `card must not use ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('claude account chip — highlighted while the re-login guide is up (R3a)', () => {
  const src = read('ClaudeLoginStatus.tsx');
  const card = read('ClaudeReloginCard.tsx');
  const chat = read('Chat.tsx');
  const css = readFileSync(join(CLIENT, '../../../../../src/app/globals.css'), 'utf8');

  it('one guide per Chat, handed to both the chip and the failure notice', () => {
    expect(chat).toContain('const [reloginGuide] = useState(createReloginGuide);');
    expect(chat).toContain('<ClaudeLoginStatus guide={reloginGuide} />');
    expect(chat).toContain('reloginGuide={reloginGuide}');
  });

  it('the card reports progress and turns the highlight off when it goes away', () => {
    expect(card).toContain('guide?.report({ active: !progress.signedInAgain, loggedOut: progress.loggedOut });');
    expect(card).toContain('useEffect(() => () => guide?.report({ active: false, loggedOut: false }), [guide]);');
  });

  it('step 1 click opens the chip menu; hover flashes the ring', () => {
    expect(card).toContain('onClick={guide.requestOpen}');
    expect(card).toContain('onMouseEnter={guide.requestFlash}');
    expect(src).toMatch(/openSeenRef\.current = guideState\.openRequest;\s*setOpen\(true\);/);
    expect(src).toMatch(/flashSeenRef\.current = guideState\.flashRequest;\s*setFlashing\(true\);/);
  });

  it('pulse ring on the trigger, outline on the item to press — through chipHighlight', () => {
    expect(src).toContain('const highlight = chipHighlight(guideState, open);');
    expect(src).toMatch(/highlight\.ring \? ' claude-chip-guide' : ''/);
    expect(src).toMatch(/flashing \? ' claude-chip-guide-flash' : ''/);
    expect(src).toContain("const GUIDE_OUTLINE = 'ring-2 ring-brand';");
    const logout = src.slice(src.indexOf('data-testid="claude-account-logout"'), src.indexOf('data-testid="claude-account-logout"') + 300);
    expect(logout).toContain('highlight.logout ?');
    const login = src.slice(src.indexOf('data-testid="claude-account-login"'), src.indexOf('data-testid="claude-account-login"') + 300);
    expect(login).toContain('highlight.login ?');
  });

  it('the keyframes: ~1.5s pulse as a box-shadow (no layout shift), held still under reduced motion', () => {
    expect(css).toMatch(/@keyframes claude-chip-guide \{[^}]*box-shadow/);
    expect(css).toMatch(/\.claude-chip-guide \{\s*animation: claude-chip-guide 1\.5s ease-in-out infinite;/);
    const reduced = css.slice(css.indexOf('.claude-chip-guide-flash {'));
    expect(reduced).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.claude-chip-guide,\s*\.claude-chip-guide-flash \{\s*animation: none;\s*box-shadow: 0 0 0 2px hsl\(var\(--brand\)\);/,
    );
    // Nothing that would move or resize the chip.
    const block = css.slice(css.indexOf('@keyframes claude-chip-guide {'), css.indexOf('@keyframes claude-chip-guide-flash'));
    expect(block).not.toMatch(/transform|width|height|margin|padding/);
  });
});
