import { describe, it, expect, vi } from 'vitest';
import {
  effectiveAgentModel,
  resolveAutoModel,
  type ModelRouteStore,
} from './modelRoute';
import {
  estimateContextTokens,
  SUBSCRIPTION_USAGE_MAX_STALE_MS,
} from '../../../../../../../dist/naby-runtime.mjs';

/**
 * SIGNAL GATHERING, WHICH IS THE HALF OF `auto` THAT CAN BREAK
 * (specs/model-auto-routing.md §4.4–§4.5, milestone M2).
 *
 * The decision table itself belongs to `spike-model-router.ts` — it is a pure
 * function and the spike drives all seven base branches and all three modifiers.
 * Repeating that here would test the same code twice and neither copy would
 * notice if this file handed the router the wrong inputs. So everything below is
 * about the WIRING: which settings row is read, how a usage window becomes a
 * percentage, when a cache is too old to be believed, what happens with no
 * catalogue at all, and — the one that matters most — that a store which throws
 * produces a model rather than a failed turn.
 *
 * HAND-ROLLED STORES, like growthRead.test.ts. `resolveAutoModel` declares the
 * three methods it is allowed to call and nothing else, so a fake is the whole
 * surface. It is also the only way to ask for a session that is 60k tokens deep
 * and an opus window that is 95% full at the same time: a real database cannot be
 * driven to a chosen percentage, and a real subscription certainly cannot.
 *
 * THE CLOCK IS ALWAYS PASSED IN. Freshness is the one thing here that depends on
 * `Date.now()`, and the difference between `fresh` and `expired` is the
 * difference between two different models answering.
 */

const NOW = 1_800_000_000_000;

/** The live catalogue's real values on this machine (§3). Not invented: these are
 *  what `models.claude.cache` holds after a successful probe. */
const LIVE_ROWS = [
  { value: 'default', displayName: 'Default', resolvedModel: 'claude-opus-5[1m]' },
  { value: 'opus[1m]', displayName: 'Opus 5 (1M)' },
  { value: 'claude-fable-5-1[1m]', displayName: 'Fable 5.1 (1M)' },
  { value: 'sonnet', displayName: 'Sonnet 5' },
  { value: 'haiku', displayName: 'Haiku 4.5' },
];

type Settings = Record<string, string>;

function makeStore(over: {
  settings?: Settings;
  messages?: { role: string; content: string }[];
  usage?: { providerId: string; model: string }[];
} = {}): ModelRouteStore {
  return {
    getMessages: () => over.messages ?? [],
    listUsage: () => over.usage ?? [],
    getSetting: (key: string) => over.settings?.[key],
  };
}

/** The settings row a successful catalogue probe writes. */
function catalogSetting(rows: unknown[] = LIVE_ROWS): Settings {
  return {
    'models.claude.cache': JSON.stringify({ fetchedAt: NOW, sdk: '0.3.259', claude: rows }),
  };
}

/** The settings row `usage.limits` writes, at a chosen age and opus fullness. */
function usageSetting(opts: {
  ageMs: number;
  opusPct?: number;
  fiveHourPct?: number;
  accountId?: string;
}): Settings {
  const extra =
    opts.opusPct === undefined
      ? {}
      : { extra: { seven_day_opus: { utilizationPercent: opts.opusPct, source: 'sdk' } } };
  const fiveHour =
    opts.fiveHourPct === undefined
      ? {}
      : { fiveHour: { utilizationPercent: opts.fiveHourPct, source: 'sdk' } };
  return {
    [`usage.limits.cache.${opts.accountId ?? 'default'}`]: JSON.stringify({
      fetchedAt: NOW - opts.ageMs,
      limits: { ...fiveHour, ...extra },
      sources: ['sdk'],
      cliReason: 'no-cache',
    }),
  };
}

const GREETING = '안녕';
/** A build request: carries a build verb, so the base rule reads it as work. */
const BUILD_ASK =
  '이 기능을 구현해줘. 턴마다 모델을 고르는 라우터를 붙이고 회귀 테스트까지 같이 넣어줘.';

function route(store: ModelRouteStore, over: Partial<Parameters<typeof resolveAutoModel>[0]> = {}) {
  return resolveAutoModel({
    store,
    sessionId: 's1',
    turnText: GREETING,
    fullMode: false,
    planMode: false,
    now: NOW,
    ...over,
  });
}

describe('the base decision, wired to a real catalogue row', () => {
  it('a greeting on an empty session is a `chat` turn, and `chat` is sonnet', () => {
    const r = route(makeStore({ settings: catalogSetting() }));
    // The main conversation's floor is sonnet (`MAIN_TURN_TIERS`): haiku dropped
    // the persona's voice and read the injected context in fragments, so the
    // quiet clause now picks the REASON and not a cheaper model.
    expect(r.tier).toBe('sonnet');
    expect(r.reason).toBe('chat');
    // The VALUE is what reaches the SDK, and it has to be a value the catalogue
    // actually lists — not the tier name by coincidence.
    expect(r.value).toBe('sonnet');
  });

  it('a SHORT question that has to be worked out is opus, not a `chat` turn', () => {
    // Length is a ceiling for `chat`, never a criterion of its own (§4.2 rule 1,
    // `deep-ask`): "왜 이렇게 동작해?" is shorter than the greeting above and the
    // answer takes reading the code until the cause is found. Same empty session
    // and same catalogue row as that case, so the only thing that differs is the
    // text — which is the point being pinned.
    const r = route(makeStore({ settings: catalogSetting() }), { turnText: '왜 이렇게 동작해?' });
    expect(r.tier).toBe('opus');
    expect(r.reason).toBe('deep-ask');
    expect(r.value).toBe('opus[1m]');
  });

  it('a request for a SCRIPT is routed down to sonnet, not up to opus', () => {
    // The one content rule that lowers a tier (`ROUTINE_KEYWORDS`): what it reads
    // is the shape of the deliverable, and a one-off script is work whose
    // correctness is visible the moment it comes back. THIS text used to come
    // back as `chat` — `짜줘` is on no keyword list, so the turn was short and
    // signal-free — while the same request phrased "스크립트 하나 만들어줘" or
    // "build a batch script" carried a build verb and went to opus. The spike
    // pins those; what this pins is the WIRING: the reason code crosses the
    // runtime boundary and the value is one the catalogue actually lists. Same
    // empty session and catalogue row as the greeting case above, so the text is
    // the only thing that differs.
    const r = route(makeStore({ settings: catalogSetting() }), { turnText: '스크립트 하나 짜줘' });
    expect(r.tier).toBe('sonnet');
    expect(r.reason).toBe('routine');
    expect(r.value).toBe('sonnet');
  });

  it('a build request goes to the 1M opus value, never the bare alias', () => {
    const r = route(makeStore({ settings: catalogSetting() }), { turnText: BUILD_ASK });
    expect(r.tier).toBe('opus');
    expect(r.reason).toBe('build-ask');
    // `opus`, not `opus[1m]`, would silently shrink the window from 1M to 200k —
    // a downgrade nobody asked for and nobody can see (§4.3).
    expect(r.value).toBe('opus[1m]');
  });

  it('plan mode takes the catalogue’s concrete fable id', () => {
    const r = route(makeStore({ settings: catalogSetting() }), { planMode: true });
    expect(r.tier).toBe('fable');
    expect(r.reason).toBe('plan-mode');
    // The live row is a concrete id; there is no `fable[1m]` alias to invent.
    expect(r.value).toBe('claude-fable-5-1[1m]');
  });
});

describe('with no catalogue cached at all', () => {
  // The completion criterion in §7: "카탈로그 캐시를 지운 상태에서도 auto 턴이
  // 실패하지 않고 별칭 값으로 간다."
  const bare = makeStore();

  it('answers with aliases rather than failing', () => {
    expect(route(bare).value).toBe('sonnet');
    expect(route(bare, { turnText: BUILD_ASK }).value).toBe('opus[1m]');
    expect(route(bare, { planMode: true }).value).toBe('fable');
  });

  it('and an unparseable catalogue row reads as "no catalogue", not as a throw', () => {
    const broken = makeStore({ settings: { 'models.claude.cache': '{ not json' } });
    expect(() => route(broken)).not.toThrow();
    expect(route(broken, { planMode: true }).value).toBe('fable');
  });

  it('a fable turn on a bare alias is still honest about its window', () => {
    // `fable` measures 200k (only `claude-fable*` ids are 1M), so a conversation
    // past that size moves a design turn to opus. §4.3 calls this the correct
    // outcome of the information we have, so it is asserted rather than papered
    // over — if it ever changes, it should change deliberately.
    const huge = makeStore({ messages: bulkMessages(400) });
    const r = route(huge, { planMode: true });
    expect(r.tier).toBe('opus');
    expect(r.reason).toBe('window-fit');
  });
});

/** ~3,000 characters per message. `estimateTokens` counts ~3.5 chars/token, so
 *  the count is chosen against the ASSERTED estimate below rather than guessed. */
function bulkMessages(count: number): { role: string; content: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${'대화 기록을 채우는 문장입니다. '.repeat(150)}`,
  }));
}

describe('the previous tier, read off this session’s usage rows', () => {
  const deep = bulkMessages(60);

  it('the fixture really is past the sticky threshold', () => {
    // The rule keys on 40k. Asserting the estimate keeps the two cases below from
    // silently testing nothing if the character rule or the system share moves.
    const tokens = estimateContextTokens(deep);
    expect(tokens).toBeGreaterThan(40_000);
    // …and still inside sonnet's 200k window, so `window-fit` is not what moves
    // the tier in the next test. That is the whole point of this assertion.
    expect(Math.round(tokens * 1.5 + 20_000)).toBeLessThan(200_000);
  });

  it('a big conversation keeps the model it was talking to, even for a greeting', () => {
    const store = makeStore({
      settings: catalogSetting(),
      messages: deep,
      usage: [
        // An earlier metered turn: a different provider's id names no tier here.
        { providerId: 'openai', model: 'gpt-5.6' },
        { providerId: 'dev-claude', model: 'claude-opus-5[1m]' },
      ],
    });
    const r = route(store);
    expect(r.tier).toBe('opus');
    expect(r.reason).toBe('sticky');
    expect(r.value).toBe('opus[1m]');
  });

  it('only dev-claude rows count, and the LAST one wins', () => {
    const store = makeStore({
      settings: catalogSetting(),
      messages: deep,
      usage: [
        { providerId: 'dev-claude', model: 'claude-opus-5[1m]' },
        // Newer (listUsage is oldest-first) and NOT dev-claude: it must not
        // overwrite the tier, or a provider switch would erase the stickiness.
        { providerId: 'google', model: 'gemini-2.5-pro' },
      ],
    });
    expect(route(store).tier).toBe('opus');
  });

  it('a dev-claude row naming no tier leaves the session unstuck', () => {
    // `default` names whatever the sign-in resolves, which is not a tier.
    const store = makeStore({
      settings: catalogSetting(),
      messages: deep,
      usage: [{ providerId: 'dev-claude', model: 'default' }],
    });
    const r = route(store);
    // Unstuck means the base rule decides, and the base rule's floor is sonnet.
    expect(r.tier).toBe('sonnet');
    expect(r.reason).toBe('chat');
  });
});

describe('the subscription cap, and the clock that decides whether to believe it', () => {
  const build = { turnText: BUILD_ASK };

  it('a fresh reading at 95% of the opus week sends a build request to sonnet', () => {
    const store = makeStore({
      settings: { ...catalogSetting(), ...usageSetting({ ageMs: 1_000, opusPct: 95 }) },
    });
    const r = route(store, build);
    expect(r.tier).toBe('sonnet');
    expect(r.reason).toBe('budget-cap');
    expect(r.value).toBe('sonnet');
  });

  it('the 5-hour window caps on its own', () => {
    const store = makeStore({
      settings: { ...catalogSetting(), ...usageSetting({ ageMs: 1_000, fiveHourPct: 92 }) },
    });
    expect(route(store, build).reason).toBe('budget-cap');
  });

  it('the same reading past the staleness ceiling caps nothing', () => {
    // §7: "캐시가 만료(expired) 상태면 같은 요청이 opus로 간다."
    const store = makeStore({
      settings: {
        ...catalogSetting(),
        ...usageSetting({ ageMs: SUBSCRIPTION_USAGE_MAX_STALE_MS, opusPct: 95 }),
      },
    });
    const r = route(store, build);
    expect(r.tier).toBe('opus');
    expect(r.reason).toBe('build-ask');
  });

  it('a row with no percentage in it is not a percentage of zero', () => {
    // `utilizationPercent` is optional on a window: a cache can be fresh and
    // still not say how full the opus week is (§2 principle 7).
    const store = makeStore({
      settings: { ...catalogSetting(), ...usageSetting({ ageMs: 1_000 }) },
    });
    expect(route(store, build).tier).toBe('opus');
  });

  it('reads the row of the account this turn is running on', () => {
    const settings = {
      ...catalogSetting(),
      ...usageSetting({ ageMs: 1_000, opusPct: 95, accountId: 'work' }),
    };
    // Named: the cap applies.
    expect(route(makeStore({ settings }), { ...build, accountId: 'work' }).reason).toBe(
      'budget-cap',
    );
    // Unnamed: this reads `…cache.default`, which is not there, so no cap.
    expect(route(makeStore({ settings }), build).tier).toBe('opus');
  });
});

describe('it cannot fail the turn', () => {
  // §4.5: "라우터가 예외를 던지면 잡아서 sonnet으로 가고 경고 로그를 남긴다.
  // 자동 선택의 실패가 턴의 실패가 되면 안 된다."
  const broken: ModelRouteStore = {
    getMessages() {
      throw new Error('database is locked');
    },
    listUsage() {
      throw new Error('database is locked');
    },
    getSetting() {
      throw new Error('database is locked');
    },
  };

  it('a store that throws yields sonnet and a warning, not an exception', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = route(broken, { turnText: BUILD_ASK });
      expect(r).toEqual({ value: 'sonnet', tier: 'sonnet', reason: 'default' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('auto routing failed');
    } finally {
      warn.mockRestore();
    }
  });

  it('the fallback is sonnet even for a turn that would have been a plan', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Not fable: a turn whose signals could not be READ is the most ambiguous
      // turn there is, and ambiguous is sonnet by instruction.
      expect(route(broken, { planMode: true }).tier).toBe('sonnet');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('effectiveAgentModel — `auto` is a chat-bar value and must never reach the SDK', () => {
  it('an empty model and an `auto` model both mean "inherit the turn’s model"', () => {
    expect(effectiveAgentModel(undefined)).toBeUndefined();
    expect(effectiveAgentModel('')).toBeUndefined();
    expect(effectiveAgentModel('   ')).toBeUndefined();
    expect(effectiveAgentModel('auto')).toBeUndefined();
    // The editor's field is free text, so a stored value can carry whitespace.
    expect(effectiveAgentModel('  auto  ')).toBeUndefined();
  });

  it('every real model is passed through unchanged', () => {
    for (const m of ['opus[1m]', 'sonnet', 'haiku', 'claude-fable-5-1[1m]', 'gpt-5.6']) {
      expect(effectiveAgentModel(m)).toBe(m);
    }
  });

  it('…and a model that carried whitespace comes back TRIMMED', () => {
    // The same free-text field that can hold `  auto  ` can hold `  sonnet  `,
    // and the SDK does not trim. Returning the raw string would send a value this
    // function judged in its trimmed form and then declined to produce.
    expect(effectiveAgentModel('  sonnet  ')).toBe('sonnet');
    expect(effectiveAgentModel('opus[1m]\n')).toBe('opus[1m]');
  });

  it('does not swallow model ids that merely contain the word', () => {
    // A guard written as `includes('auto')` would erase these.
    expect(effectiveAgentModel('autopilot-1')).toBe('autopilot-1');
    expect(effectiveAgentModel('claude-auto-5')).toBe('claude-auto-5');
  });
});
