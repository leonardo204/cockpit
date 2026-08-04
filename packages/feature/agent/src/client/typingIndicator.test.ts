import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE SENTENCE THE WAITING TAB SHOWS.
 *
 * A tab that opens onto a turn it did not start — the fast-growth session's
 * opening question, a Telegram message, a scheduled task — now shows the
 * existing loading bubble instead of an empty conversation. The bubble is the
 * one that already existed (same spinner, same elapsed clock, same Stop); only
 * the sentence changes, because "Claude is thinking" is an answer to a question
 * this user never asked.
 *
 * WHY A SOURCE TEST. There is no DOM in this suite, and the two ways this breaks
 * are both invisible to the type checker:
 *   * the key is missing from a locale — i18next silently falls back to the
 *     English `defaultValue`, so a Korean user reads English mid-sentence,
 *   * the wiring is dropped (Chat stops passing `viewerRun`) — the indicator
 *     still renders, saying the wrong thing, and nothing errors.
 */

/** The `packages/` root — this file sits at packages/feature/agent/src/client. */
const ROOT = join(__dirname, '../../../..');

function dict(locale: string): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(join(ROOT, 'shared/i18n/locales', `${locale}.json`), 'utf8'));
}

function source(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

describe('the "naby is typing" indicator', () => {
  it('has its line in BOTH locales', () => {
    for (const locale of ['en', 'ko'] as const) {
      expect(dict(locale).chat?.typing, `chat.typing missing in ${locale}.json`).toBeTruthy();
    }
  });

  it('names naby, in the persona voice each locale already uses elsewhere', () => {
    // ko calls it 나비 everywhere (growth panel, check-in prompt); en calls it a
    // lowercase "naby". The indicator has no business inventing a third name.
    expect(dict('ko').chat!.typing).toContain('나비');
    expect(dict('en').chat!.typing).toContain('naby');
  });

  it('carries no interpolation — this line already knows who is speaking', () => {
    // `chat.thinking` interpolates WHO is answering (the acting agent, and only an
    // engine brand where there is no agent at all — actingAgent.ts). This one is
    // naby speaking first, so a stray {{name}} would render literally.
    for (const locale of ['en', 'ko'] as const) {
      expect(dict(locale).chat!.typing).not.toContain('{{');
    }
  });

  it('is what the loading bubble says for a turn this tab did not send', () => {
    const list = source('feature/agent/src/client/MessageList.tsx');
    // The one loading bubble, choosing between the two sentences.
    expect(list).toContain("t('chat.typing'");
    expect(list).toContain("t('chat.thinking'");
    expect(list).toMatch(/viewerRun\s*\n?\s*\?\s*t\('chat\.typing'/);
  });

  it('is wired from the live stream, not from this tab\'s own send', () => {
    const chat = source('feature/agent/src/client/Chat.tsx');
    // `liveRunning` is what the session-stream reports (including a turn that is
    // merely reserved); `isLoading` is this tab as the originator. The typing
    // line belongs to the first and not the second.
    expect(chat).toContain('viewerRun={liveRunning && !isLoading}');
  });

  it('does not blank the session it is shown over', () => {
    // The indicator now goes up for a turn that has been reserved and has not
    // started. The initial disk load skips itself while the live stream owns the
    // tail — and if that skip keyed off the live FLAG, a session opened during
    // that window would show the typing bubble over an empty transcript until the
    // turn ended. It keys off the rendered live bubbles instead, of which there
    // are none before the turn starts.
    const history = source('feature/agent/src/client/useChatHistory.ts');
    expect(history).toMatch(/liveRunningRef\?\.current &&[\s\S]{0,160}startsWith\('live-'\)/);
  });

  it('is driven by a signal that covers the not-yet-started turn', () => {
    // The empty-tab bug: the attach arrived before the headless turn started.
    const hook = source('feature/agent/src/client/useLiveStream.ts');
    expect(hook).toContain('runSignalFor');
    expect(source('feature/agent/src/client/runSignal.ts')).toContain("case 'run-pending'");
  });
});
