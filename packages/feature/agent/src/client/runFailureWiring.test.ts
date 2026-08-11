import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE WIRING BEHIND runFailure.ts.
 *
 * The rules are unit-tested to the last case in runFailure.test.ts, and every
 * one of those tests would still pass if nobody called the reducer. What is
 * asserted here is the connection, and the three things a pure test cannot see:
 *
 *   1. the notice is rendered OUTSIDE the transcript — a sibling of
 *      <MessageList/>, never a row in `messages`. That is the entire fix: the
 *      post-run reconcile rewrites `messages` from disk, so anything living in
 *      there is erased with it;
 *   2. every failing path reports (the in-stream `{type:'error'}` event, the
 *      POST that never started a run, the socket watchdog, and the viewer's
 *      copy of the same run), and the report is cleared at the START of a send,
 *      which is the one line every send path passes through;
 *   3. the provider's message reaches the screen VERBATIM and bounded — the
 *      quota reply ("limit: 0, model: gemini-2.5-pro") is the actionable part,
 *      and it is also long enough to shove the composer off screen if nothing
 *      caps it.
 *
 * Source assertions rather than rendered ones, for the reason recorded in
 * sidebarPopoverClipping.test.ts and composerHistoryWiring.test.ts: this suite
 * has no DOM environment (see vitest.config.ts), so there is nothing to mount.
 */

/** The `packages/` root — this file sits at packages/feature/agent/src/client. */
const ROOT = join(__dirname, '../../../..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const AGENT = 'feature/agent/src/client';
const chat = read(`${AGENT}/Chat.tsx`);
const notice = read(`${AGENT}/RunFailureNotice.tsx`);
const stream = read(`${AGENT}/useChatStream.ts`);
const live = read(`${AGENT}/useLiveStream.ts`);
const en = JSON.parse(read('shared/i18n/locales/en.json')) as Record<string, Record<string, string>>;
const ko = JSON.parse(read('shared/i18n/locales/ko.json')) as Record<string, Record<string, string>>;

describe('the premise — a reconcile really does rewrite the transcript from disk', () => {
  it('the run still ends by re-syncing messages to disk', () => {
    // If this ever goes away, the rules below are free to relax. Asserting the
    // premise keeps this suite from silently guarding nothing.
    expect(chat).toMatch(/onRunComplete: \(\) => reconcileFromDiskRef\.current\?\.\(\)/);
    expect(chat).toMatch(/reconcileFromDiskRef\.current = \(\) => \{[\s\S]*?loadHistoryByCwdAndSessionId\(/);
  });

  it('and the error is still rendered into the bubble for the rest of the turn', () => {
    // The in-turn copy is not what broke; losing it at reconcile was. Both
    // engines' reducers keep drawing it.
    expect(stream).toMatch(/withAssistantText\(msg, msg\.content \? `\\n\\n⚠️ \$\{errText\}` : `⚠️ \$\{errText\}`\)/);
  });
});

describe('Chat — the failure is held outside the message array', () => {
  it('keeps it in its own state, moved only by the tested reducer', () => {
    expect(chat).toMatch(/from '\.\/runFailure'/);
    expect(chat).toMatch(/const \[runFailure, setRunFailure\] = useState<RunFailure \| null>\(null\)/);
    expect(chat).toMatch(/setRunFailure\(\(prev\) => runFailureReducer\(prev, ev\)\)/);
    // Exactly one writer: every other path goes through dispatchRunFailure, so
    // no call site can invent a clearing rule of its own.
    expect(chat.match(/setRunFailure\(/g)).toHaveLength(1);
  });

  it('NEVER puts it into `messages` — that is what the reconcile erases', () => {
    expect(chat).not.toMatch(/setMessages\([^)]*runFailure/);
    // …and the notice is not fed the transcript either.
    expect(chat).toMatch(/<RunFailureNotice failure=\{runFailure\} onDismiss=\{dismissRunFailure\} \/>/);
    expect(chat).not.toMatch(/<RunFailureNotice[^/]*messages=/);
  });

  it('renders it as a SIBLING of the transcript, below the conversation', () => {
    const list = chat.indexOf('<MessageList');
    const noticeAt = chat.indexOf('<RunFailureNotice');
    const input = chat.indexOf('<ChatInput');
    expect(list).toBeGreaterThan(-1);
    expect(noticeAt).toBeGreaterThan(list);
    expect(input).toBeGreaterThan(noticeAt);
    // Outside the scrolling messages block: the notice comes after that block's
    // closing tag, so nothing inside the transcript's own layout clips it.
    const messagesBlockEnd = chat.indexOf('{/* Token Usage Display */}');
    expect(messagesBlockEnd).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(messagesBlockEnd);
  });

  it('states in code that a reconcile does not clear it', () => {
    // Both reconcile paths — the originator's and the viewer's — pass through
    // the reducer, whose 'history-reconciled' case returns the state untouched.
    expect(chat).toMatch(
      /reconcileFromDiskRef\.current = \(\) => \{[\s\S]*?loadHistoryByCwdAndSessionId\([\s\S]*?dispatchRunFailure\(\{ type: 'history-reconciled' \}\)/,
    );
    expect(chat).toMatch(
      /onComplete: \(\) => \{[\s\S]*?loadHistoryByCwdAndSessionId\([\s\S]*?dispatchRunFailure\(\{ type: 'history-reconciled' \}\)/,
    );
  });

  it('retires it when the tab moves to another session', () => {
    expect(chat).toMatch(
      /useEffect\(\(\) => \{\s*dispatchRunFailure\(\{ type: 'session', sessionId: liveSessionId \?\? null \}\);\s*\}, \[liveSessionId, dispatchRunFailure\]\)/,
    );
  });

  it('records WHO was asked from the same id the session check uses', () => {
    expect(chat).toMatch(/failureContextRef\.current = \{[\s\S]*?sessionId: liveSessionId \?\? null,\s*\}/);
    // The model that ACTUALLY answered wins over the picked slug, and neither
    // is replaced by a "Default" placeholder.
    expect(chat).toMatch(/model: liveModel \|\| selectedModelRef\.current \|\| '',/);
    expect(chat).toMatch(/engine: engineBrand,/);
  });
});

describe('useChatStream — every failing path reports, and a send clears', () => {
  it('reports the in-stream error event verbatim', () => {
    const branch = stream.slice(stream.indexOf("if (eventType === 'error')"));
    expect(branch.indexOf('onRunErrorRef.current?.(errText)')).toBeGreaterThan(-1);
    // The raw provider text, not a rewritten one.
    expect(branch).toMatch(/const errText = \(event\.error as string\) \|\|/);
  });

  it('reports a POST that never started a run, and the dead-socket watchdog', () => {
    expect(stream).toMatch(/console\.error\('Chat error:', error\);[\s\S]{0,220}onRunErrorRef\.current\?\.\(errorMsg\)/);
    expect(stream).toMatch(/if \(activeRunRef\.current && !wsAliveRef\.current\) \{\s*onRunErrorRef\.current\?\.\(/);
  });

  it('CLEARS at the start of the send, before the run is even dispatched', () => {
    const send = stream.indexOf('const handleSend = useCallback(');
    expect(send).toBeGreaterThan(-1);
    const clear = stream.indexOf('onRunErrorRef.current?.(null)', send);
    const post = stream.indexOf('const response = await fetch(apiUrl', send);
    expect(clear).toBeGreaterThan(send);
    expect(post).toBeGreaterThan(clear);
  });

  it('hands the callback down through a ref, like every other host callback', () => {
    // A fresh closure per render must not churn the stable useCallbacks that
    // read it (shell React performance conventions).
    expect(stream).toMatch(/const onRunErrorRef = useRef\(onRunError\);\s*\n\s*onRunErrorRef\.current = onRunError;/);
  });
});

describe('useLiveStream — a watched run that fails reports the same way', () => {
  it('reports the error and still lets the reducer draw the in-turn copy', () => {
    expect(live).toMatch(/if \(ev\.type === 'error' && ev\.error\) opts\?\.onRunError\?\.\(ev\.error\);/);
    // No `return` in that branch: applyStreamEvent below still gets the event.
    const at = live.indexOf("if (ev.type === 'error' && ev.error)");
    const line = live.slice(at, live.indexOf('\n', at));
    expect(line).not.toContain('return');
  });

  it('is wired from Chat to the same single handler as the originator', () => {
    expect(chat).toMatch(/onRunError: handleRunError,/g);
    expect(chat.match(/onRunError: handleRunError,/g)).toHaveLength(2);
  });
});

describe('RunFailureNotice — the provider is quoted, not summarised', () => {
  it('renders the whole message verbatim, wrapped rather than truncated', () => {
    expect(notice).toContain('{message}');
    expect(notice).toMatch(/whitespace-pre-wrap/);
    expect(notice).toMatch(/break-words/);
  });

  it('bounds its height and scrolls, so a paragraph cannot push the composer away', () => {
    const detail = /data-testid="run-failure-detail"[\s\S]*?className="([^"]+)"/.exec(notice)?.[1];
    expect(detail, 'detail block className not found — did the markup change?').toBeDefined();
    expect(detail).toMatch(/max-h-\d+/);
    expect(detail).toContain('overflow-y-auto');
  });

  it('opens by default and can be collapsed, re-opening for a NEW failure', () => {
    expect(notice).toMatch(/useState\(true\)/);
    expect(notice).toMatch(/useEffect\(\(\) => \{\s*setExpanded\(true\);\s*\}, \[at\]\)/);
    expect(notice).toMatch(/data-testid="run-failure-toggle"/);
  });

  it('shows which provider and model failed, through the tested helpers', () => {
    expect(notice).toMatch(/from '\.\/runFailure'/);
    expect(notice).toMatch(/runFailureOrigin\(failure\)/);
    expect(notice).toMatch(/runFailureHeadline\(message\)/);
  });
});

describe('UI copy goes through i18n in both languages', () => {
  const keys = [
    'runFailedTitle',
    'runFailedOn',
    'runFailedDetails',
    'runFailedHide',
    'runFailedDismiss',
    'runFailedHint',
  ];

  it('has every key in en and ko', () => {
    for (const key of keys) {
      expect(en.chat?.[key], `en chat.${key}`).toBeTruthy();
      expect(ko.chat?.[key], `ko chat.${key}`).toBeTruthy();
      // Translated, not copied.
      expect(ko.chat?.[key], `ko chat.${key} is untranslated`).not.toBe(en.chat?.[key]);
    }
    // The interpolation survives translation.
    expect(en.chat?.runFailedOn).toContain('{{origin}}');
    expect(ko.chat?.runFailedOn).toContain('{{origin}}');
  });

  it('the component reads them through t(), with no hardcoded label', () => {
    for (const key of keys) {
      expect(notice, `chat.${key} not read through t()`).toMatch(new RegExp(`t\\('chat\\.${key}'`));
    }
  });
});
