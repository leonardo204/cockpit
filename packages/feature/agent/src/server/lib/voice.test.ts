import { describe, it, expect } from 'vitest';
import {
  createVoicePort,
  readVoiceStats,
  reattachProtocolMarkers,
  splitProtocolMarkers,
  VOICE_STATS_KEY,
  type VoiceStore,
} from './voice';
import { DONE_MARKER, VERIFIED_MARKER_PREFIX } from './autonomy';
import {
  serializeStyleFingerprint,
  STYLE_FINGERPRINT_KEY,
  VOICE_TURN_REWRITE_CAP,
  type EngineEvent,
  type EngineRunInput,
  type StyleFingerprint,
} from '../../../../../../../dist/naby-runtime.mjs';
import type { JudgeBackend } from './reflection';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A settings store that is a Map, and reports every write so a test can assert
 *  that a gate stopped one rather than merely that the value looks unchanged. */
function fakeStore(seed: Record<string, string> = {}): VoiceStore & {
  writes: { key: string; value: string }[];
  rows: Map<string, string>;
} {
  const rows = new Map<string, string>(Object.entries(seed));
  const writes: { key: string; value: string }[] = [];
  return {
    rows,
    writes,
    getSetting: (key) => rows.get(key),
    setSetting: (key, value) => {
      writes.push({ key, value });
      rows.set(key, value);
    },
  };
}

/** A backend whose model answers with whatever the test says, and which records
 *  the prompts it was given. */
function fakeBackend(
  reply: string | ((input: EngineRunInput) => string | Promise<string>),
): JudgeBackend & { calls: EngineRunInput[] } {
  const calls: EngineRunInput[] = [];
  return {
    calls,
    label: 'fake',
    model: { providerId: 'fake', model: 'fake-1' },
    engine: {
      async *run(input: EngineRunInput): AsyncIterable<EngineEvent> {
        calls.push(input);
        const text = typeof reply === 'function' ? await reply(input) : reply;
        yield { kind: 'init', providerId: 'fake', model: 'fake-1' };
        yield { kind: 'text', role: 'assistant', text };
        yield { kind: 'result', ok: true, usage: { inputTokens: 120, outputTokens: 40 } };
      },
    },
  } as JudgeBackend & { calls: EngineRunInput[] };
}

const SESSION = 's-voice';

/** Korean, plain `~다`, long enough to be judged, with nothing in it that the
 *  verifier protects — so a test's rewrite can differ freely. */
const KOREAN_BODY = '세션 스토어는 런타임에 둔다. 프로바이더를 바꿔도 남아야 하는 코드이기 때문이다.';
const KOREAN_REWRITE = '세션 스토어는 런타임에 있다. 프로바이더를 교체해도 남아야 하는 코드다.';
const KOREAN_USER = '세션 스토어를 어디에 두는 게 좋을지 알려줘. 지금 구조가 좀 헷갈린다.';
const ENGLISH_BODY =
  'The session store belongs in the runtime, because it has to survive a provider swap.';

function req(text: string, signal?: AbortSignal) {
  return {
    text,
    userText: KOREAN_USER,
    sessionId: SESSION,
    signal: signal ?? new AbortController().signal,
  };
}

const FINGERPRINT: StyleFingerprint = {
  sampleCount: 60,
  sentenceCount: 240,
  avgSentenceChars: 30,
  endings: { formal: 0.7, polite: 0.1, fragment: 0.2 },
  questionRatio: 0.2,
  listRatio: 0.1,
  computedAt: 1_700_000_000_000,
};

// ---------------------------------------------------------------------------

describe('protocol markers', () => {
  it('takes [[DONE]] and [[VERIFIED: …]] out of the body and puts them back in protocol order', () => {
    const text = `작업을 마쳤다.\n${VERIFIED_MARKER_PREFIX} ran the suite, 51/51 pass]]\n${DONE_MARKER}`;
    const split = splitProtocolMarkers(text);
    expect(split.body).toBe('작업을 마쳤다.');
    expect(split.done).toBe(true);
    expect(split.verified).toHaveLength(1);

    const back = reattachProtocolMarkers('작업을 끝냈다.', split);
    expect(back.split('\n').at(-1)).toBe(DONE_MARKER);
    expect(back).toContain(VERIFIED_MARKER_PREFIX);
    expect(back.startsWith('작업을 끝냈다.')).toBe(true);
  });

  it('is case-insensitive, like the autonomy loop that reads the markers', () => {
    const split = splitProtocolMarkers('끝.\n[[done]]');
    expect(split.done).toBe(true);
    expect(split.body).toBe('끝.');
  });

  // -- review defect 7 -------------------------------------------------------
  //
  // A MARKER INSIDE A FENCE IS CODE. An answer that EXPLAINS the autonomy
  // protocol contains `[[DONE]]` in a code block, and the splitter used to cut it
  // out of the block and re-attach it as the answer's last line: the code sample
  // silently lost the line it was demonstrating, and the layer that promises to
  // preserve code character for character became the only thing in the app that
  // rewrote one.
  it('leaves a marker inside a code fence exactly where it is', () => {
    const text = [
      '자율 루프는 이렇게 끝난다.',
      '',
      '```md',
      '작업을 마쳤다.',
      '[[DONE]]',
      '```',
      '',
      '마지막 줄에 그대로 쓰면 된다.',
    ].join('\n');
    const split = splitProtocolMarkers(text);
    expect(split.done).toBe(false);
    expect(split.verified).toHaveLength(0);
    expect(split.body).toBe(text);
    // …and re-attaching changes nothing, so the block cannot drift on the way out.
    expect(reattachProtocolMarkers(split.body, split)).toBe(text);
  });

  it('still finds a REAL marker that sits outside the fence of the same answer', () => {
    const text = [
      '자율 루프는 이렇게 끝난다.',
      '',
      '```md',
      '[[DONE]]',
      '```',
      '',
      '설명은 여기까지다.',
      DONE_MARKER,
    ].join('\n');
    const split = splitProtocolMarkers(text);
    expect(split.done).toBe(true);
    // The fenced copy survives; only the loose one was taken.
    expect(split.body).toContain('```md\n[[DONE]]\n```');
    expect(split.body.split('\n').at(-1)).toBe('설명은 여기까지다.');
  });

  it('treats an inline-code marker as code too', () => {
    const split = splitProtocolMarkers('마지막 줄에 `[[DONE]]` 를 쓴다.');
    expect(split.done).toBe(false);
    expect(split.body).toBe('마지막 줄에 `[[DONE]]` 를 쓴다.');
  });
});

describe('createVoicePort — the markers survive a rewrite', () => {
  it('never shows the markers to the model and re-attaches them to the result', async () => {
    const store = fakeStore();
    const backend = fakeBackend(KOREAN_REWRITE);
    const port = createVoicePort({
      store,
      stage: 'butterfly',
      learningAllowed: true,
      resolveBackend: async () => backend,
    });

    const text = `${KOREAN_BODY}\n${VERIFIED_MARKER_PREFIX} ran the suite]]\n${DONE_MARKER}`;
    const out = await port.render(req(text));

    // What the model was asked
    expect(backend.calls).toHaveLength(1);
    const prompt = String(backend.calls[0]!.messages[0]!.role === 'user' ? (backend.calls[0]!.messages[0] as { content: string }).content : '');
    expect(prompt).not.toContain(DONE_MARKER);
    expect(prompt).not.toContain(VERIFIED_MARKER_PREFIX);

    // What the user gets
    expect(out).toContain(KOREAN_REWRITE);
    expect(out.split('\n').at(-1)).toBe(DONE_MARKER);
    expect(out).toContain(VERIFIED_MARKER_PREFIX);
  });

  it('leaves a block that is nothing but a marker completely alone', async () => {
    const backend = fakeBackend('rewritten');
    const port = createVoicePort({
      store: fakeStore(),
      stage: 'butterfly',
      learningAllowed: true,
      resolveBackend: async () => backend,
    });
    const out = await port.render(req(DONE_MARKER));
    expect(out).toBe(DONE_MARKER);
    expect(backend.calls).toHaveLength(0);
  });
});

describe('createVoicePort — the per-turn cap', () => {
  it(`spends ${VOICE_TURN_REWRITE_CAP} calls on a butterfly turn and then stops entirely`, async () => {
    const backend = fakeBackend(KOREAN_REWRITE);
    const port = createVoicePort({
      store: fakeStore(),
      stage: 'butterfly',
      learningAllowed: true,
      resolveBackend: async () => backend,
    });

    // No deviation: Korean answer, Korean user, no fingerprint. Only the stage
    // rule is buying these calls.
    for (let i = 0; i < VOICE_TURN_REWRITE_CAP; i += 1) {
      await port.render(req(KOREAN_BODY));
    }
    expect(backend.calls).toHaveLength(VOICE_TURN_REWRITE_CAP);

    const afterCap = await port.render(req(KOREAN_BODY));
    expect(backend.calls).toHaveLength(VOICE_TURN_REWRITE_CAP);
    expect(afterCap).toBe(KOREAN_BODY);

    // …and a MEASURED deviation does not buy one either (review defect 9). The cap
    // used to fall back to the deviation rule, which is not a cap: `length` fires
    // on almost any step, so a twenty-step run could spend twenty calls while
    // reporting that it had stopped at three.
    const past = await port.render(req(ENGLISH_BODY));
    expect(backend.calls).toHaveLength(VOICE_TURN_REWRITE_CAP);
    expect(past).toBe(ENGLISH_BODY);
  });

  it('does not call at all on an egg turn whose answer is already in the user\'s voice', async () => {
    const backend = fakeBackend(KOREAN_REWRITE);
    const port = createVoicePort({
      store: fakeStore(),
      stage: 'egg',
      learningAllowed: true,
      resolveBackend: async () => backend,
    });
    const out = await port.render(req(KOREAN_BODY));
    expect(backend.calls).toHaveLength(0);
    expect(out).toBe(KOREAN_BODY);
  });
});

describe('createVoicePort — every failure returns the original', () => {
  it('no backend on this machine', async () => {
    const store = fakeStore();
    const port = createVoicePort({
      store,
      stage: 'butterfly',
      learningAllowed: true,
      resolveBackend: async () => undefined,
    });
    expect(await port.render(req(KOREAN_BODY))).toBe(KOREAN_BODY);
    expect(store.writes).toHaveLength(0);
  });

  it('a provider error', async () => {
    const store = fakeStore();
    const backend: JudgeBackend = {
      label: 'boom',
      model: { providerId: 'fake' },
      engine: {
        async *run(): AsyncIterable<EngineEvent> {
          throw new Error('provider exploded');
          yield { kind: 'result', ok: false };
        },
      },
    };
    const port = createVoicePort({
      store,
      stage: 'butterfly',
      learningAllowed: true,
      resolveBackend: async () => backend,
    });
    expect(await port.render(req(KOREAN_BODY))).toBe(KOREAN_BODY);
    expect(store.writes).toHaveLength(0);
  });

  it('the turn is stopped while the call is in flight — the call is cancelled and the original goes out', async () => {
    const store = fakeStore();
    let sawAbort = false;
    let announceStart!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStart = resolve;
    });
    const backend: JudgeBackend = {
      label: 'hangs',
      model: { providerId: 'fake' },
      engine: {
        async *run(input: EngineRunInput): AsyncIterable<EngineEvent> {
          announceStart();
          // The same shape a timeout takes: the call never answers, and the only
          // thing that ends it is the signal — which is the turn's own, wired
          // through by the port.
          await new Promise<void>((resolve) => {
            if (input.signal.aborted) resolve();
            else input.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          sawAbort = true;
          throw new Error('aborted');
        },
      },
    };
    const controller = new AbortController();
    const port = createVoicePort({
      store,
      stage: 'butterfly',
      learningAllowed: true,
      resolveBackend: async () => backend,
    });
    const pending = port.render(req(KOREAN_BODY, controller.signal));
    // Stop is pressed only once the call is genuinely in flight — pressing it
    // earlier would exercise the cheaper pre-call guard instead.
    await started;
    controller.abort();
    expect(await pending).toBe(KOREAN_BODY);
    expect(sawAbort).toBe(true);
    expect(store.writes).toHaveLength(0);
  });

  it('a rewrite that fails verification is discarded, not shown', async () => {
    const store = fakeStore();
    const withUrl = `${KOREAN_BODY} 자세한 내용은 https://example.com/store 에 있다.`;
    // Same prose, URL dropped: exactly the failure §6 exists to catch.
    const backend = fakeBackend(KOREAN_REWRITE);
    const port = createVoicePort({
      store,
      stage: 'butterfly',
      learningAllowed: true,
      resolveBackend: async () => backend,
    });
    const out = await port.render(req(withUrl));
    expect(backend.calls).toHaveLength(1);
    expect(out).toBe(withUrl);
    expect(store.writes).toHaveLength(0);
  });

  it('a rewrite that summarises is discarded on the length ratio', async () => {
    const store = fakeStore();
    const backend = fakeBackend('런타임.');
    const port = createVoicePort({
      store,
      stage: 'butterfly',
      learningAllowed: true,
      resolveBackend: async () => backend,
    });
    expect(await port.render(req(KOREAN_BODY))).toBe(KOREAN_BODY);
    expect(store.writes).toHaveLength(0);
  });
});

describe('createVoicePort — the totals (§7)', () => {
  it('counts an adopted rewrite by its reason', async () => {
    const store = fakeStore();
    const backend = fakeBackend(KOREAN_REWRITE);
    const port = createVoicePort({
      store,
      stage: 'egg',
      learningAllowed: true,
      resolveBackend: async () => backend,
      now: () => 1_800_000_000_000,
    });

    // An English answer to a Korean user: a LANGUAGE deviation, which is what an
    // egg-stage turn spends a call on.
    const out = await port.render(req(ENGLISH_BODY));
    expect(out).toBe(KOREAN_REWRITE);

    const stats = readVoiceStats(store);
    expect(stats.rewrites).toBe(1);
    expect(stats.byReason.language).toBe(1);
    expect(stats.lastAt).toBe(1_800_000_000_000);
  });

  it('records `stage` when the rewrite was bought by the stage rule alone', async () => {
    const store = fakeStore();
    const port = createVoicePort({
      store,
      stage: 'butterfly',
      learningAllowed: true,
      resolveBackend: async () => fakeBackend(KOREAN_REWRITE),
    });
    await port.render(req(KOREAN_BODY));
    expect(readVoiceStats(store).byReason.stage).toBe(1);
  });

  it('writes NOTHING when this turn may not learn — the rewrite still happens', async () => {
    const store = fakeStore();
    const port = createVoicePort({
      store,
      stage: 'butterfly',
      learningAllowed: false,
      resolveBackend: async () => fakeBackend(KOREAN_REWRITE),
    });
    const out = await port.render(req(KOREAN_BODY));
    expect(out).toBe(KOREAN_REWRITE);
    expect(store.writes.filter((w) => w.key === VOICE_STATS_KEY)).toHaveLength(0);
    expect(readVoiceStats(store).rewrites).toBe(0);
  });

  it('accumulates across renders', async () => {
    const store = fakeStore();
    const port = createVoicePort({
      store,
      stage: 'butterfly',
      learningAllowed: true,
      resolveBackend: async () => fakeBackend(KOREAN_REWRITE),
    });
    await port.render(req(KOREAN_BODY));
    await port.render(req(KOREAN_BODY));
    expect(readVoiceStats(store).rewrites).toBe(2);
  });

  it('an unreadable totals row reads as empty rather than throwing', () => {
    expect(readVoiceStats(fakeStore({ [VOICE_STATS_KEY]: 'not json' }))).toEqual({
      rewrites: 0,
      byReason: {},
      lastAt: 0,
    });
    expect(
      readVoiceStats({
        getSetting: () => {
          throw new Error('store is gone');
        },
      }),
    ).toEqual({ rewrites: 0, byReason: {}, lastAt: 0 });
  });
});

describe('createVoicePort — which rules the rewrite is checked against', () => {
  // THE SECOND REVIEW'S DEFECT 1, from the shell's side. The runtime owns the two
  // bands; this owns the choice between them, and the choice is made from the
  // REASON the call was made — so these tests are about what the port does with a
  // reply, not about arithmetic.

  /** A faithful English→Korean translation of the paragraph below: 0.32x the
   *  characters, and one negation where the English has none. Every one of those
   *  differences is what a translation IS, and the style band refuses all of them. */
  const ENGLISH_PARAGRAPH =
    'You should keep the invariants in one place, because the moment there are two copies of them one of the two will be the one that is out of date, and the code that reads it will be wrong in a way that nobody can see.';
  const KOREAN_TRANSLATION =
    '불변식은 한곳에 둔다. 사본이 둘이면 한쪽은 반드시 낡아버리고, 그것을 읽는 코드는 아무도 못 보는 방식으로 틀리게 된다.';

  it('adopts a faithful translation the single band used to refuse', async () => {
    const store = fakeStore();
    const backend = fakeBackend(KOREAN_TRANSLATION);
    const port = createVoicePort({
      store,
      stage: 'egg',
      learningAllowed: true,
      resolveBackend: async () => backend,
    });
    // English answer, Korean user: a LANGUAGE deviation, so the call is a
    // translation and is checked as one.
    const out = await port.render(req(ENGLISH_PARAGRAPH));
    expect(out).toBe(KOREAN_TRANSLATION);
    expect(readVoiceStats(store).byReason.language).toBe(1);
  });

  it('refuses a rewrite that translated an answer nobody asked to have translated', async () => {
    const store = fakeStore();
    // A butterfly turn restyles with no measured deviation at all — a STYLE call.
    // The reply is honest by every other measure (1.22x, same negation count, no
    // protected token in either text); the only thing wrong with it is that it is
    // in another language, which until this fix was not a rule at all.
    const backend = fakeBackend('The store belongs in the runtime layer, where it stays.');
    const port = createVoicePort({
      store,
      stage: 'butterfly',
      learningAllowed: true,
      resolveBackend: async () => backend,
    });
    const out = await port.render(req(KOREAN_BODY));
    expect(backend.calls).toHaveLength(1);
    expect(out).toBe(KOREAN_BODY);
    expect(store.writes).toHaveLength(0);
  });

  it('tells a style call to keep the language and a language call to change it', async () => {
    const styleBackend = fakeBackend(KOREAN_REWRITE);
    const stylePort = createVoicePort({
      store: fakeStore(),
      stage: 'butterfly',
      learningAllowed: true,
      resolveBackend: async () => styleBackend,
    });
    await stylePort.render(req(KOREAN_BODY));
    expect(String(styleBackend.calls[0]!.system)).toContain(
      'DO NOT CHANGE THE LANGUAGE OF THE ANSWER',
    );

    const translateBackend = fakeBackend(KOREAN_REWRITE);
    const translatePort = createVoicePort({
      store: fakeStore(),
      stage: 'egg',
      learningAllowed: true,
      resolveBackend: async () => translateBackend,
    });
    await translatePort.render(req(ENGLISH_BODY));
    const system = String(translateBackend.calls[0]!.system);
    expect(system).toContain('Render the answer in the language the USER wrote in');
    expect(system).not.toContain('DO NOT CHANGE THE LANGUAGE');
  });

  it('a turn that named a language is checked as a RESTYLE, deviation or not', async () => {
    // "커밋 메시지 써줘" produces English on purpose. The suppressor already keeps
    // this from being called a language deviation; the mode rule keeps a call made
    // for some OTHER reason from being allowed to translate it.
    const store = fakeStore();
    const backend = fakeBackend('커밋 메시지는 이렇게 쓴다. 제목은 명령형으로 둔다.');
    const port = createVoicePort({
      store,
      stage: 'butterfly',
      learningAllowed: true,
      turnText: '방금 고친 내용으로 커밋 메시지 하나 써줘.',
      resolveBackend: async () => backend,
    });
    const english =
      'Fix the voice layer so a style rewrite can never change the language of an answer.';
    const out = await port.render(req(english));
    expect(backend.calls).toHaveLength(1);
    expect(String(backend.calls[0]!.system)).toContain('DO NOT CHANGE THE LANGUAGE OF THE ANSWER');
    expect(out).toBe(english);
  });
});

describe('createVoicePort — what it measures the answer against', () => {
  it('uses the RUN\'s user text, not the harness continuation prompt', async () => {
    const store = fakeStore();
    const backend = fakeBackend(KOREAN_REWRITE);
    const port = createVoicePort({
      store,
      stage: 'egg',
      learningAllowed: true,
      turnText: ENGLISH_BODY, // the user really did write in English
      resolveBackend: async () => backend,
    });
    // The step's own user message is Korean; `turnText` says the run is English,
    // so an English answer is NOT a deviation and an egg turn spends nothing.
    const out = await port.render(req(ENGLISH_BODY));
    expect(backend.calls).toHaveLength(0);
    expect(out).toBe(ENGLISH_BODY);
  });

  it('reads the stored style fingerprint, so an ending deviation is measurable', async () => {
    const store = fakeStore({
      [STYLE_FINGERPRINT_KEY]: serializeStyleFingerprint(FINGERPRINT),
    });
    const backend = fakeBackend(KOREAN_REWRITE);
    const port = createVoicePort({
      store,
      stage: 'egg',
      learningAllowed: true,
      resolveBackend: async () => backend,
    });
    const polite =
      '세션 스토어는 런타임에 두는 게 좋아요. 프로바이더를 바꿔도 남아야 하니까요. 셸은 액션만 맡아요.';
    await port.render(req(polite));
    expect(backend.calls).toHaveLength(1);
    expect(readVoiceStats(store).byReason.endings).toBe(1);
  });
});
