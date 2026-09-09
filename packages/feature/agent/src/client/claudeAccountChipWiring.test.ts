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

  it('reads the account block from the same GET the chip already polls', () => {
    expect(src).toContain('claudeAccounts?: ClaudeAccountsBlock');
    expect(src).toContain('setAccounts(data.claudeAccounts ?? null)');
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
    expect(src).toContain("action: 'claude-account.verify'");
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
