import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { ClaudeReloginCard } from './ClaudeReloginCard';
import { RunFailureNotice } from './RunFailureNotice';
import { createReloginGuide, publishClaudeLoginStatus, type ReloginGuide, type ReloginProgress } from './claudeLoginFlow';
import type { RunFailure } from './runFailure';

/**
 * specs/claude-relogin-guide.md §1.2–1.3 — what the re-login guide and the
 * failure notice SAY at each step, in both languages. There is no DOM harness
 * in this repo, so each step is rendered statically (as messageQueueWiring
 * does); the progress fold itself is claudeLoginFlow.test.ts.
 */

const noop = () => {};
const RAW = 'Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed';
const START: ReloginProgress = { loggedOut: false, signedInAgain: false };
const OUT: ReloginProgress = { loggedOut: true, signedInAgain: false };
const BACK: ReloginProgress = { loggedOut: true, signedInAgain: true };

function card(progress: ReloginProgress, opts: { resend?: boolean; detail?: string; guide?: ReloginGuide } = {}): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ClaudeReloginCard
        initialProgress={progress}
        {...(opts.guide ? { guide: opts.guide } : {})}
        detail={opts.detail ?? RAW}
        {...(opts.resend === false ? {} : { onResend: noop })}
      />
    </I18nextProvider>,
  );
}

function notice(failure: RunFailure, onResend?: () => void): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <RunFailureNotice failure={failure} onDismiss={noop} {...(onResend ? { onResend } : {})} />
    </I18nextProvider>,
  );
}

/** Text content, tags stripped and entities decoded enough for these strings. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const step = (html: string, n: number) => new RegExp(`data-testid="claude-relogin-step${n}" data-done="(true|false)"`).exec(html)?.[1];

let prevLng: string;
beforeAll(() => {
  prevLng = i18n.language;
});
afterAll(async () => {
  await i18n.changeLanguage(prevLng);
});
afterEach(() => publishClaudeLoginStatus(null));

describe('ClaudeReloginCard — the four steps (ko)', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ko');
  });

  it('spells out the spec text, controls in bold', () => {
    const html = card(START);
    const body = text(html);
    expect(body).toContain('Claude 로그인이 만료되었습니다. 아래 순서대로 다시 로그인하면 이어서 쓸 수 있습니다.');
    expect(body).toContain('채팅 위의 Claude 칩(계정 이메일)을 누릅니다.');
    expect(body).toContain('메뉴에서 로그아웃을 누릅니다.');
    expect(body).toContain('칩에 나타나는 로그인을 누르고, 열리는 브라우저에서 로그인을 마칩니다.');
    expect(body).toContain('돌아와서 아래 다시 보내기를 누릅니다.');
    expect(body).toContain('브라우저가 열리지 않으면 터미널에서 다음 명령을 실행하세요: claude auth login');
    expect(html).toContain('<strong>Claude 칩</strong>');
    expect(html).toContain('<strong>로그아웃</strong>');
    expect(html).toContain('data-testid="claude-relogin-copy"');
    expect(html).not.toContain('**');
  });

  it('nothing ticked yet; "다시 보내기" is already clickable, not emphasised (R5)', () => {
    const html = card(START);
    expect([1, 2, 3, 4].map((n) => step(html, n))).toEqual(['false', 'false', 'false', 'false']);
    expect(html).toMatch(/data-testid="claude-relogin-resend" data-emphasis="false"/);
    expect(html).not.toMatch(/claude-relogin-resend"[^>]*disabled/);
  });

  it('signed out → step 2 ✓', () => {
    const html = card(OUT);
    expect(step(html, 2)).toBe('true');
    expect(step(html, 3)).toBe('false');
    expect(html).toContain('✓');
  });

  it('signed in again → step 3 ✓ and "다시 보내기" emphasised', () => {
    const html = card(BACK);
    expect(step(html, 3)).toBe('true');
    expect(html).toMatch(/data-testid="claude-relogin-resend" data-emphasis="true"/);
  });

  it('follows the chip\'s published status: a card opening signed out starts at step 2 ✓', () => {
    publishClaudeLoginStatus('signed-out');
    const html = card(START);
    expect(step(html, 2)).toBe('true');
    publishClaudeLoginStatus('signed-in');
    // Signed in WITHOUT a logout seen first is the expired session itself.
    expect(step(card(START), 3)).toBe('false');
  });

  it('nothing to resend: asks the user instead of a button (R5)', () => {
    const html = card(BACK, { resend: false });
    expect(html).not.toContain('data-testid="claude-relogin-resend"');
    expect(text(html)).toContain('메시지를 다시 보내 주세요.');
  });

  it('the SDK original is folded under "자세히", closed by default (R8)', () => {
    const html = card(START);
    expect(html).toContain('data-testid="claude-relogin-detail-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('OAuth session expired');
    expect(card(START, { detail: '' })).not.toContain('claude-relogin-detail-toggle');
  });
});

describe('ClaudeReloginCard — en', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  it('every step reads in English', () => {
    const body = text(card(START));
    expect(body).toContain('Your Claude sign-in has expired. Sign in again with these steps to carry on.');
    expect(body).toContain('Click the Claude chip (your account email) above the chat.');
    expect(body).toContain('Choose Log out in its menu.');
    expect(body).toContain('Click Log in on the chip, and finish signing in in the browser that opens.');
    expect(body).toContain('Come back and press Send again below.');
    expect(body).toContain('If no browser opens, run this in a terminal: claude auth login');
    expect(text(card(BACK, { resend: false }))).toContain('Please send your message again.');
  });
});

describe('RunFailureNotice — the guide for an expired sign-in, the plain report otherwise', () => {
  const base = { sessionId: 's-1', at: 1, engine: 'Claude' } as const;

  beforeAll(async () => {
    await i18n.changeLanguage('ko');
  });

  it('authentication_failed → the guide card instead of the headline', () => {
    const html = notice({
      ...base,
      message: 'Claude 로그인이 만료되었습니다. Claude 칩에서 로그아웃한 뒤 다시 로그인해 주세요.',
      code: 'authentication_failed',
      detail: RAW,
    });
    expect(html).toContain('data-testid="claude-relogin-card"');
    expect(html).not.toContain('data-testid="run-failure-headline"');
    expect(html).not.toContain('data-testid="run-failure-detail"');
    expect(html).not.toContain('data-testid="run-failure-toggle"');
    expect(html).toContain('data-testid="run-failure-dismiss"');
  });

  it('any other failure keeps the plain report', () => {
    const html = notice({ ...base, message: 'AI 응답 중 오류: socket hang up', code: 'ENGINE_THREW' });
    expect(html).not.toContain('claude-relogin-card');
    expect(html).toContain('data-testid="run-failure-headline"');
  });

  it('R9: the hint mentions "자세히" only when there is a 자세히 button', () => {
    const oneLine = notice({ ...base, message: 'AI 응답 중 오류: socket hang up' });
    expect(oneLine).not.toContain('data-testid="run-failure-toggle"');
    expect(text(oneLine)).toContain('다음 메시지를 보내면 사라집니다.');
    expect(text(oneLine)).not.toContain('자세히에서');

    const long = notice({ ...base, message: 'first line\nsecond line with the detail' });
    expect(long).toContain('data-testid="run-failure-toggle"');
    expect(text(long)).toContain('자세히에서 전체 내용을 볼 수 있습니다. 다음 메시지를 보내면 사라집니다.');
  });
});

describe('step 1 — "Claude 칩" leads to the chip (R3a)', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ko');
  });

  it('with the conversation\'s guide, the words are a button', () => {
    const html = card(START, { guide: createReloginGuide() });
    expect(html).toMatch(/<button type="button" data-testid="claude-relogin-chip-link"[^>]*>Claude 칩<\/button>/);
    expect(html).not.toContain('<strong>Claude 칩</strong>');
    // Only step 1's bold becomes the link; the others stay emphasis.
    expect(html).toContain('<strong>로그아웃</strong>');
  });

  it('without one (no chip to point at), plain emphasis', () => {
    expect(card(START)).toContain('<strong>Claude 칩</strong>');
    expect(card(START)).not.toContain('claude-relogin-chip-link');
  });
});
