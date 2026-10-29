import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { QueuedMessages } from './QueuedMessages';
import type { QueuedMessage } from './messageQueue';

/**
 * specs/chat-message-queue.md — the wiring around the pure rules in
 * messageQueue.ts. There is no DOM harness in this repo, so the cards are
 * rendered statically and the Chat / ChatInput wiring is pinned by source
 * assertions (the same approach as runFailureWiring.test.ts).
 */

const CLIENT = __dirname;
const read = (f: string) => readFileSync(join(CLIENT, f), 'utf8');
const LOCALES = join(CLIENT, '..', '..', '..', '..', 'shared', 'i18n', 'locales');
const noop = () => {};

function render(items: QueuedMessage[]): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <QueuedMessages items={items} onEdit={noop} onDelete={noop} />
    </I18nextProvider>,
  );
}

let prevLng: string;
beforeAll(() => {
  prevLng = i18n.language;
});
afterAll(async () => {
  await i18n.changeLanguage(prevLng);
});

describe('QueuedMessages — the "send next" cards', () => {
  it('renders nothing for an empty queue', () => {
    expect(render([])).toBe('');
  });

  it('one card per message, with body, image count, edit and delete', async () => {
    await i18n.changeLanguage('en');
    const html = render([
      { id: 'a', content: 'first question' },
      {
        id: 'b',
        content: 'second',
        images: [
          { id: 'i1', data: 'x', preview: 'p', media_type: 'image/png' },
          { id: 'i2', data: 'y', preview: 'q', media_type: 'image/png' },
        ],
      },
    ]);
    expect(html.match(/data-testid="queued-message"/g)).toHaveLength(2);
    expect(html).toContain('first question');
    expect(html).toContain('2 images');
    expect(html.match(/data-testid="queued-message-edit"/g)).toHaveLength(2);
    expect(html.match(/data-testid="queued-message-delete"/g)).toHaveLength(2);
    expect(html).toContain('Sending next');
    // Two lines of the body, not the whole thing.
    expect(html).toContain('line-clamp-2');
  });

  it('speaks Korean', async () => {
    await i18n.changeLanguage('ko');
    const html = render([{ id: 'a', content: '', images: [{ id: 'i', data: 'x', preview: 'p', media_type: 'image/png' }] }]);
    expect(html).toContain('보낼 예정');
    expect(html).toContain('이미지 1개');
    expect(html).toContain('수정');
    expect(html).toContain('삭제');
  });
});

describe('ChatInput — a send during a run is queued, not blocked', () => {
  const src = read('ChatInput.tsx');

  it('routes to onQueue while running, onSend otherwise', () => {
    expect(src).toContain('(running ? onQueue! : onSend)(trimmed, images.length > 0 ? images : undefined);');
    expect(src).toContain('}, [input, images, disabled, running, onQueue, onSend]);');
  });

  it('shows the running placeholder while a run is in flight', () => {
    expect(src).toMatch(/placeholder=\{\s*disabled \|\| running\s*\?/);
  });

  it('applies a hand-back once per nonce and appends after the draft', () => {
    expect(src).toContain('appliedRestoreRef.current === restoreDraft.nonce');
    expect(src).toContain('appendToDraft(inputRef.current, restoreDraft.content)');
  });
});

describe('Chat — the queue is settled on run end', () => {
  const src = read('Chat.tsx');

  it('no longer disables the composer during a run', () => {
    const input = src.slice(src.indexOf('<ChatInput'), src.indexOf('/>', src.indexOf('<ChatInput')));
    expect(input).not.toContain('disabled=');
    expect(input).toContain('running={running}');
    expect(input).toContain('onQueue={handleQueueMessage}');
    expect(input).toContain('restoreDraft={composerRestore}');
  });

  it('renders the cards right above the composer', () => {
    const cards = src.indexOf('<QueuedMessages');
    expect(cards).toBeGreaterThan(-1);
    expect(cards).toBeLessThan(src.indexOf('<ChatInput'));
  });

  it('auto-sends through wrappedHandleSend, via settleRunEnd', () => {
    expect(src).toContain('autoSendRef.current = wrappedHandleSend;');
    expect(src).toContain("if (action.kind === 'send') void autoSendRef.current(action.content, action.images);");
    expect(src).toContain("else if (action.kind === 'restore') restoreToComposer(action);");
    expect(src).toContain('const { state, action } = settleRunEnd(queueRef.current);');
  });

  it('every stop marks the queue stopped (ESC, transcript, popup handle)', () => {
    // The stream's raw stop is called in exactly one place: the wrapper.
    expect(src.match(/\bhandleStop\(\)/g)).toHaveLength(1);
    expect(src).toContain('commitQueue(markStopped(queueRef.current));');
    expect(src).toContain('onStopHandle(handleStopRun);');
    expect(src).toContain('onStop={handleStopRun}');
    expect(src).toMatch(/e\.key === 'Escape'[\s\S]{0,80}handleStopRun\(\)/);
  });

  it('an error marks the queue errored; a new send clears it', () => {
    expect(src).toContain('commitQueue(markErrored(queueRef.current));');
    expect(src).toContain('commitQueue(clearRunOutcome(queueRef.current));');
  });
});

describe('running placeholder copy (R7)', () => {
  const en = JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8')).chat as Record<string, string>;
  const ko = JSON.parse(readFileSync(join(LOCALES, 'ko.json'), 'utf8')).chat as Record<string, string>;

  it('says the message will be sent after the turn', () => {
    expect(ko.placeholderDisabled).toBe('생각하는 중입니다. 지금 보내면 끝난 뒤 이어서 보냅니다 (ESC로 중단)');
    expect(ko.placeholderDisabledCompact).toBe('끝난 뒤 이어서 보냅니다 (ESC로 중단)');
    expect(en.placeholderDisabled).toMatch(/after this turn/);
    expect(en.placeholderDisabledCompact).toMatch(/after this turn/);
  });
});
