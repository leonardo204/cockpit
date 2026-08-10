import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE "CLAUDE CODE IS NOT INSTALLED" CARD in Settings → AI provider.
 *
 * Claude (subscription) answers on the Claude Code sign-in that lives on this
 * computer. When there is no `claude` executable at all, the app used to say the
 * CLI "was not found … install it, then run the command below" — advice only for
 * someone who already knows where "it" comes from. This card is the answer to
 * WHERE and HOW: the official setup page as a link, the command for this
 * platform with a copy button, the alternatives, and the two facts worth knowing
 * before starting (no administrator rights; a paid plan is required).
 *
 * SOURCE ASSERTIONS, for the same reason as `providerSetupRefresh.test.ts`:
 * there is no React renderer in this suite, and everything below is WIRING —
 * which endpoint the re-check calls, that no command string is hardcoded here,
 * that both dictionaries carry the copy.
 *
 * THE COMMANDS THEMSELVES ARE NOT TESTED HERE. They live in the runtime
 * (`claudeInstallHelp`), where the platform choice is a pure function and
 * `npm run spike:claude-auth` asserts the Windows answer from a Mac. This file's
 * job is the opposite one: proving the UI does NOT have its own copy of them.
 */

const DIR = __dirname;

/** Source with comments stripped — this file's own prose names the very strings
 *  it asserts are absent. */
const read = (f: string) =>
  readFileSync(join(DIR, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const SETUP = read('NabyProviderSetup.tsx');

const dict = (locale: string): Record<string, Record<string, string>> =>
  JSON.parse(
    readFileSync(join(DIR, '../../../..', 'shared/i18n/locales', `${locale}.json`), 'utf8'),
  );

describe('the install card appears only when there is genuinely no CLI', () => {
  it('is gated on the runtime having produced install help', () => {
    // `installHelp` is non-null ONLY when the runtime resolved no `claude`
    // executable, so a machine that merely needs to SIGN IN never sees this —
    // that is the session bar chip's job.
    expect(SETUP).toContain('{state.devEngineAvailable && state.claudeLogin?.installHelp && (');
  });

  it('an older server (no claudeLogin block) renders nothing rather than crashing', () => {
    expect(SETUP).toContain('claudeLogin?: ClaudeLoginBlock;');
  });
});

describe('what the card offers', () => {
  it('links the official setup guide, and opens it in the OS browser', () => {
    // target="_blank" is what electron/boot.ts turns into "open outside the app".
    const anchor = SETUP.slice(SETUP.indexOf('data-testid="claude-install-docs"') - 400);
    expect(anchor).toContain('href={help.docsUrl}');
    expect(anchor).toContain('target="_blank"');
    expect(anchor).toContain('rel="noreferrer"');
  });

  it('shows the recommended command AND the alternatives, each with a copy button', () => {
    expect(SETUP).toContain('<InstallCommandRow entry={help.recommended} />');
    expect(SETUP).toContain('help.alternatives.map((entry) => (');
    expect(SETUP).toContain('data-testid={`claude-install-copy-${entry.id}`}');
    expect(SETUP).toContain('navigator.clipboard.writeText(entry.command)');
  });

  it('carries the caveats the runtime attached', () => {
    expect(SETUP).toContain('help.notes.map((note) => (');
    expect(SETUP).toContain("'no-admin-required': 'claudeInstall.noteNoAdmin'");
    expect(SETUP).toContain("'paid-plan-required': 'claudeInstall.notePaidPlan'");
  });

  it('writes no install command of its own — every one comes from the runtime', () => {
    // The single most important assertion in this file. A copy of these strings
    // in the UI is a copy that goes stale the day the official instructions
    // change, and it would go stale silently.
    expect(SETUP).not.toContain('claude.ai/install');
    expect(SETUP).not.toContain('winget install');
    expect(SETUP).not.toContain('brew install');
    expect(SETUP).not.toContain('@anthropic-ai/claude-code');
    expect(SETUP).not.toContain('code.claude.com');
  });

  it('does not offer to run the installer for the user', () => {
    const card = SETUP.slice(SETUP.indexOf('function ClaudeCliMissingCard'));
    expect(card.slice(0, 3000)).not.toContain('exec');
    expect(card.slice(0, 3000)).not.toContain('spawn');
  });
});

describe('"Check again" after installing', () => {
  it('reuses the existing recheckLogin path instead of a new endpoint', () => {
    expect(SETUP).toContain("`/api/naby${recheckLogin ? '?recheckLogin=1' : ''}`");
    expect(SETUP).toContain('const fresh = await nabyGet(true);');
    expect(SETUP).toContain('onRecheck={() => void recheckCli()}');
  });

  it('ordinary reads do NOT bypass the runtime login cache', () => {
    // The cache is what stops a settings screen spawning `claude auth status`
    // on every poll; only the explicit user action may skip it.
    expect(SETUP).toContain('async function nabyGet(recheckLogin = false)');
    expect(SETUP).toContain('setState(await nabyGet());');
  });

  it('a failed re-check keeps the card rather than blanking the section', () => {
    expect(SETUP).toContain('if (fresh) setState(fresh);');
  });
});

describe('the copy exists in both languages', () => {
  const KEYS = [
    'missing',
    'why',
    'docsLink',
    'recommended',
    'alternatives',
    'routePowershell',
    'routeCmd',
    'routeWinget',
    'routeNativeScript',
    'routeHomebrew',
    'routeNpm',
    'noteNoAdmin',
    'notePaidPlan',
    'copy',
    'copied',
    'recheck',
    'rechecking',
  ];

  it('en and ko both carry every key the component asks for', () => {
    for (const locale of ['en', 'ko']) {
      const d = dict(locale);
      for (const key of KEYS) {
        expect(d.claudeInstall?.[key], `${locale}.claudeInstall.${key}`).toBeTruthy();
      }
    }
  });

  it('every t() key used by the card is one of them', () => {
    const used = new Set(
      [...SETUP.matchAll(/'claudeInstall\.([A-Za-z]+)'/g)].map((m) => m[1] as string),
    );
    expect(used.size).toBeGreaterThan(0);
    for (const key of used) expect(KEYS).toContain(key);
  });

  it('states the plan requirement in both languages — the fact that wastes an evening', () => {
    expect(dict('en').claudeInstall!.notePaidPlan).toMatch(/free plan/i);
    expect(dict('ko').claudeInstall!.notePaidPlan).toContain('무료 플랜');
    expect(dict('en').claudeInstall!.noteNoAdmin).toMatch(/administrator/i);
    expect(dict('ko').claudeInstall!.noteNoAdmin).toContain('관리자 권한');
  });
});
