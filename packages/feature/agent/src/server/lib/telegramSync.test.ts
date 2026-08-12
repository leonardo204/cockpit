// Desktop-turn mirroring (telegram-chat §8) — the `always` delivery mode.
//
// Everything here runs on fakes: a Map-backed store and an injected MirrorIo.
// No bot, no database, no engine — the same footing as telegramChat.test.ts.

import { describe, it, expect } from 'vitest';
import {
  formatMirrorMessage,
  mirrorTurn,
  MIRROR_PROMPT_PREVIEW_CHARS,
  type MirrorIo,
  type MirrorTurn,
} from './telegramSync';
import { markChatTurn } from './telegramEscalation';

function fakeStore(settings: Record<string, string>, sessions: Record<string, { title?: string }> = {}) {
  const map = new Map(Object.entries(settings));
  return {
    getSetting: (k: string) => map.get(k),
    setSetting: (k: string, v: string) => void map.set(k, v),
    getSession: (id: string) => (sessions[id] ? { sessionId: id, ...sessions[id] } : undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const ALWAYS = {
  'telegram.enabled': 'true',
  'telegram.botToken': 'TOKEN',
  'telegram.chatId': 'CHAT',
  'telegram.syncMode': 'always',
};

function fakeIo(sendOk = true): { io: MirrorIo; sent: string[]; remembered: Array<[number, string]> } {
  const sent: string[] = [];
  const remembered: Array<[number, string]> = [];
  return {
    sent,
    remembered,
    io: {
      send: async (text: string) => {
        sent.push(text);
        return sendOk ? { ok: true as const, messageId: 77 } : { ok: false as const, error: 'nope' };
      },
      remember: (messageId: number, sessionId: string) => void remembered.push([messageId, sessionId]),
    },
  };
}

function turn(overrides: Partial<MirrorTurn> = {}): MirrorTurn {
  return {
    source: 'chat',
    sessionId: 'sess-1',
    prompt: '오늘 할 일 정리해줘',
    ok: true,
    text: '세 가지를 정리했습니다.',
    durationMs: 12_000,
    numTurns: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// the render (pure)
// ---------------------------------------------------------------------------

describe('telegramSync — the mirror message (§8.2)', () => {
  it('carries the session title, the quoted request and the report skeleton', () => {
    const msg = formatMirrorMessage('아침 브리핑', turn());
    expect(msg).toContain('🔁 아침 브리핑');
    expect(msg).toContain('🙋 오늘 할 일 정리해줘');
    expect(msg).toContain('naby finished'); // formatFinalReport's head
    expect(msg).toContain('세 가지를 정리했습니다.');
  });

  it('falls back to the session id when the session has no title', () => {
    expect(formatMirrorMessage(undefined, turn())).toContain('🔁 sess-1');
    expect(formatMirrorMessage('   ', turn())).toContain('🔁 sess-1');
  });

  it('omits the request line when the turn had no prompt (images-only)', () => {
    const msg = formatMirrorMessage('t', turn({ prompt: undefined }));
    expect(msg).not.toContain('🙋');
  });

  it('caps the quoted request', () => {
    const msg = formatMirrorMessage('t', turn({ prompt: 'x'.repeat(1000) }));
    const quote = msg.split('\n').find((l) => l.startsWith('🙋'))!;
    expect(quote.length).toBeLessThanOrEqual('🙋 '.length + MIRROR_PROMPT_PREVIEW_CHARS + 1);
  });

  it('frames a failed turn as stopped, with the error as the body', () => {
    const msg = formatMirrorMessage('t', turn({ ok: false, text: undefined, error: 'model quota exceeded' }));
    expect(msg).toContain('stopped');
    expect(msg).toContain('model quota exceeded');
  });
});

// ---------------------------------------------------------------------------
// the guards (§8.3) and the send
// ---------------------------------------------------------------------------

describe('telegramSync — mirrorTurn', () => {
  it('mirrors a finished desktop turn in always mode, and registers the reply route (§8.4)', async () => {
    const { io, sent, remembered } = fakeIo();
    const store = fakeStore(ALWAYS, { 'sess-1': { title: '아침 브리핑' } });
    const out = await mirrorTurn(store, turn(), io);
    expect(out.mirrored).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('🔁 아침 브리핑');
    expect(remembered).toEqual([[77, 'sess-1']]);
  });

  it('does nothing in manual mode — the pre-v0.2 behavior, untouched', async () => {
    const { io, sent } = fakeIo();
    const store = fakeStore({ ...ALWAYS, 'telegram.syncMode': 'manual' });
    const out = await mirrorTurn(store, turn(), io);
    expect(out).toEqual({ mirrored: false, reason: 'manual-mode' });
    expect(sent).toHaveLength(0);
  });

  it('does nothing when the channel is not ready, whatever the mode says', async () => {
    const { io, sent } = fakeIo();
    const store = fakeStore({ ...ALWAYS, 'telegram.chatId': '' });
    const out = await mirrorTurn(store, turn(), io);
    expect(out).toEqual({ mirrored: false, reason: 'not-ready' });
    expect(sent).toHaveLength(0);
  });

  it('never mirrors a Telegram-originated turn — the chat path already answered (§8.3)', async () => {
    const { io, sent } = fakeIo();
    const store = fakeStore(ALWAYS);
    const out = await mirrorTurn(store, turn({ source: 'telegram' }), io);
    expect(out).toEqual({ mirrored: false, reason: 'telegram-turn' });
    expect(sent).toHaveLength(0);
  });

  it('the in-flight chat mark is the belt to the source check', async () => {
    const { io, sent } = fakeIo();
    const store = fakeStore(ALWAYS);
    markChatTurn('sess-1', true);
    try {
      const out = await mirrorTurn(store, turn(), io);
      expect(out).toEqual({ mirrored: false, reason: 'telegram-turn' });
      expect(sent).toHaveLength(0);
    } finally {
      markChatTurn('sess-1', false);
    }
  });

  it('a failed send is reported, not retried, and registers no reply route (§8.2)', async () => {
    const { io, sent, remembered } = fakeIo(false);
    const store = fakeStore(ALWAYS);
    const out = await mirrorTurn(store, turn(), io);
    expect(out).toEqual({ mirrored: false, reason: 'send-failed' });
    expect(sent).toHaveLength(1); // exactly one attempt
    expect(remembered).toHaveLength(0);
  });

  it('mirrors a failed turn — silence would read as "still running"', async () => {
    const { io, sent } = fakeIo();
    const store = fakeStore(ALWAYS);
    const out = await mirrorTurn(store, turn({ ok: false, text: undefined, error: 'boom' }), io);
    expect(out.mirrored).toBe(true);
    expect(sent[0]).toContain('stopped');
    expect(sent[0]).toContain('boom');
  });
});
