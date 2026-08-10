import { describe, it, expect } from 'vitest';
import { createNabySpec, getStore } from './naby';
import { readGrowth } from '../lib/growthRead';
import { VOICE_STATS_KEY } from '../lib/voice';
import {
  BUILTIN_PERSONA_ID,
  serializeStyleFingerprint,
  STYLE_FINGERPRINT_KEY,
  VOICE_PREVENTIVE_THRESHOLD,
  type EngineEvent,
  type EngineRunInput,
  type StyleFingerprint,
} from '../../../../../../../dist/naby-runtime.mjs';
import type { JudgeBackend } from '../lib/reflection';
import type { RunCtx, RunEvent } from './types';

/**
 * THE NABY LAYER, WIRED INTO A REAL TURN (P3-M14a, two review defects).
 *
 * These drive the production `createNabySpec` — the same spec the chat route
 * loads — through the two injection seams the engine already exposes
 * (`resolveModel`, `resolveVoiceBackend`), so what is asserted is the wiring
 * itself and not a re-statement of it. Both defects were about a decision the
 * engine makes for the layer, which is exactly the part a unit test of
 * `lib/voice.ts` cannot see:
 *
 *   DEFECT 5  The stage was read off `subjectGrowth`, which is only populated
 *             when a CHECK-IN tool was built — so a temporary (noLearn) session
 *             had no stage, and "a butterfly always restyles" quietly became
 *             "only on a measured deviation". Spec §2 principle 5: the switches
 *             decide what naby RECORDS, never what it may use.
 *
 *   DEFECT 6  The preventive switch widened the style fingerprint onto SPECIALIST
 *             turns — the one place the comment right above it forbids — while
 *             doing nothing at all for the ordinary turns that already carry the
 *             line. The feedback now takes the shape it should have had: one
 *             explicit language sentence, added to the block that is already
 *             being injected.
 *
 * NO NETWORK AND NO KEYS: both the answering model and the restyling backend are
 * hand-rolled. The store is the throwaway one vitest.setup.ts points
 * NABY_DB_PATH at.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KOREAN_USER = '세션 스토어를 어디에 두는 게 좋을지 알려줘. 지금 구조가 좀 헷갈린다.';
/** Korean, plain `~다`, three sentences, nothing the verifier protects — so it is
 *  a NON-deviation: only the stage rule can buy a rewrite of this. */
const KOREAN_ANSWER =
  '세션 스토어는 런타임에 둔다. 프로바이더를 바꿔도 남아야 하는 코드이기 때문이다. 셸은 HTTP 액션만 맡는다.';
const KOREAN_REWRITE =
  '세션 스토어는 런타임에 있다. 프로바이더를 교체해도 남아야 하는 코드다. 셸은 HTTP 액션만 맡는다.';

const FINGERPRINT: StyleFingerprint = {
  sampleCount: 60,
  sentenceCount: 240,
  avgSentenceChars: 30,
  endings: { formal: 0.7, polite: 0.1, fragment: 0.2 },
  questionRatio: 0.2,
  listRatio: 0.1,
  computedAt: 1_700_000_000_000,
};

/** The one line the fingerprint renders — asserted as a substring so the test
 *  does not restate the whole sentence. */
const STYLE_LINE_HEAD = 'Observed writing style of this user';
/** The explicit language directive the drift totals now buy (review defect 6). */
const LANGUAGE_LINE_HEAD = 'Answer in the language the user wrote this turn in';

type Seen = { system?: string };

/** The smallest thing `ai@7` will accept as a model: it records the system prompt
 *  and answers with the text the test chose. Hand-rolled rather than `ai/test`'s
 *  mock because the engine runs inside the prebuilt runtime bundle, which carries
 *  its OWN copy of `ai`. */
function recordingModel(seen: Seen, answer: string) {
  return {
    specificationVersion: 'v4' as const,
    provider: 'mock',
    modelId: 'claude-sonnet-4-5',
    supportedUrls: {},
    async doGenerate(options: { prompt: unknown }) {
      const prompt = options.prompt as { role: string; content: unknown }[];
      const system = prompt.find((m) => m.role === 'system');
      if (system && typeof system.content === 'string') seen.system = system.content;
      return {
        content: [{ type: 'text' as const, text: answer }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage: {
          inputTokens: { total: 1234, noCache: 1234, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [] as never[],
      };
    },
    async doStream() {
      throw new Error('not used');
    },
  };
}

/** A restyling backend that answers with a fixed rewrite and counts its calls. */
function fakeVoiceBackend(reply: string): JudgeBackend & { calls: EngineRunInput[] } {
  const calls: EngineRunInput[] = [];
  return {
    calls,
    label: 'fake-voice',
    model: { providerId: 'fake', model: 'fake-1' },
    engine: {
      async *run(input: EngineRunInput): AsyncIterable<EngineEvent> {
        calls.push(input);
        yield { kind: 'init', providerId: 'fake', model: 'fake-1' };
        yield { kind: 'text', role: 'assistant', text: reply };
        yield { kind: 'result', ok: true, usage: { inputTokens: 100, outputTokens: 30 } };
      },
    },
  } as JudgeBackend & { calls: EngineRunInput[] };
}

function harness(sessionId: string, prompt: string): { ctx: RunCtx; events: RunEvent[] } {
  const events: RunEvent[] = [];
  let key = sessionId;
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: '',
    sessionId,
    params: { prompt, engine: 'naby', model: 'claude-sonnet-4-5' },
    signal: new AbortController().signal,
    emit(event: RunEvent) {
      events.push(event);
    },
    rekey(id: string) {
      key = id;
    },
    currentKey() {
      return key;
    },
  };
  return { ctx, events };
}

/** Everything the client would render as the assistant's words. */
function streamedText(events: RunEvent[]): string {
  return events
    .filter((e) => e.type === 'stream_event')
    .map((e) => {
      const ev = e.event as { delta?: { text?: string } } | undefined;
      return ev?.delta?.text ?? '';
    })
    .join('');
}

/**
 * Give the persona a record good enough to reach pupa/butterfly.
 *
 * Twenty check-ins, every one taken as recommended: the Wilson lower bound on a
 * clean 20/20 clears the butterfly threshold, and the questions are distinct so
 * none of them is excluded as degenerate.
 */
function seedGrownPersona(store: ReturnType<typeof getStore>, sessionId: string): void {
  for (let i = 0; i < 20; i += 1) {
    store.appendEvalEvent({
      kind: 'checkin',
      agentId: BUILTIN_PERSONA_ID,
      sessionId,
      at: 1_700_000_000_000 + i * 60_000,
      question: `배포 전에 ${i}번 항목을 먼저 확인할까?`,
      options: ['먼저 확인한다', '그냥 진행한다'],
      recommended: 0,
      chosen: 0,
      hit: true,
      confidence: 0.7,
    });
  }
}

// ---------------------------------------------------------------------------
// Defect 5 — the stage does not come from the check-in switch
// ---------------------------------------------------------------------------

describe('the naby layer reads the stage from the ledger, not from the check-in switch', () => {
  it('restyles a TEMPORARY session at the stage the persona actually earned', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'source');
    seedGrownPersona(store, sessionId);
    // The precondition, asserted rather than assumed: a test that seeded a
    // still-egg persona would pass for the wrong reason.
    const stage = readGrowth(store, BUILTIN_PERSONA_ID)?.stage;
    expect(stage === 'pupa' || stage === 'butterfly').toBe(true);

    // A temporary session: it learns nothing and writes no ledger row — which is
    // exactly what used to erase the stage and switch the layer off.
    const run = store.createSession('', 'source');
    store.setSessionNoLearn(run.sessionId, true);

    const seen: Seen = {};
    const voice = fakeVoiceBackend(KOREAN_REWRITE);
    const spec = createNabySpec({
      resolveModel: () => recordingModel(seen, KOREAN_ANSWER) as never,
      resolveVoiceBackend: async () => voice,
    });
    const { ctx, events } = harness(run.sessionId, KOREAN_USER);
    await spec.runner.run(ctx);

    // The answer had NO measurable deviation — Korean answer, Korean user — so
    // only the stage rule can have bought this call.
    expect(voice.calls).toHaveLength(1);
    expect(streamedText(events)).toContain(KOREAN_REWRITE);
  });
});

// ---------------------------------------------------------------------------
// Defect 6 — what repeated language drift actually buys
// ---------------------------------------------------------------------------

describe('repeated language drift adds a line to the turns that already carry one', () => {
  /** Put the app in the state the preventive rule reacts to: a usable fingerprint
   *  and more language corrections than the threshold. */
  function seedDrift(store: ReturnType<typeof getStore>, languageDrift: number): void {
    store.setSetting(STYLE_FINGERPRINT_KEY, serializeStyleFingerprint(FINGERPRINT));
    store.setSetting(
      VOICE_STATS_KEY,
      JSON.stringify({
        rewrites: languageDrift,
        byReason: { language: languageDrift },
        lastAt: 1_800_000_000_000,
      }),
    );
  }

  async function runTurn(prompt: string): Promise<Seen> {
    const store = getStore();
    const { sessionId } = store.createSession('', 'source');
    const seen: Seen = {};
    const spec = createNabySpec({
      resolveModel: () => recordingModel(seen, KOREAN_ANSWER) as never,
      resolveVoiceBackend: async () => undefined,
    });
    const { ctx } = harness(sessionId, prompt);
    await spec.runner.run(ctx);
    return seen;
  }

  it('never widens the style fingerprint onto a SPECIALIST turn', async () => {
    const store = getStore();
    seedDrift(store, VOICE_PREVENTIVE_THRESHOLD + 2);
    store.putAgent({
      name: 'drifter',
      kind: 'custom',
      systemPrompt: 'You review SQL migrations and nothing else.',
      memoryScope: 'project',
      autonomy: { escalation: 'none' },
    });

    const seen = await runTurn('@drifter 이 마이그레이션 검토해줘. 인덱스가 빠진 것 같다.');
    // The work was routed AWAY from the persona precisely because it is not
    // personal. Neither half of the personal voice may follow it there.
    expect(seen.system ?? '').not.toContain(STYLE_LINE_HEAD);
    expect(seen.system ?? '').not.toContain(LANGUAGE_LINE_HEAD);
  });

  it('adds an explicit language directive to the persona turn once drift is proven', async () => {
    const store = getStore();
    seedDrift(store, VOICE_PREVENTIVE_THRESHOLD);
    const seen = await runTurn(KOREAN_USER);
    expect(seen.system ?? '').toContain(STYLE_LINE_HEAD);
    expect(seen.system ?? '').toContain(LANGUAGE_LINE_HEAD);
  });

  it('says nothing extra while the drift is still one bad turn', async () => {
    const store = getStore();
    seedDrift(store, VOICE_PREVENTIVE_THRESHOLD - 1);
    const seen = await runTurn(KOREAN_USER);
    expect(seen.system ?? '').toContain(STYLE_LINE_HEAD);
    expect(seen.system ?? '').not.toContain(LANGUAGE_LINE_HEAD);
  });
});
