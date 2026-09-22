import { describe, it, expect } from 'vitest';
import {
  CLAUDE_CONTEXT_WINDOW,
  CLAUDE_1M_CONTEXT_WINDOW,
  CONTEXT_1M_BETA,
  FALLBACK_CONTEXT_WINDOW,
  contextWindowFor,
  reportedContextWindow,
  requestedOneMTier,
} from '../../../../../../../dist/naby-runtime.mjs';
import { resolveContextWindow } from './contextWindow';

/**
 * The context-window registry (specs/session-context-management.md §2.1) — the
 * DENOMINATOR of the status-bar gauge and of the AI-SDK engine's fold threshold.
 *
 * It is asserted from the SHELL side because the shell is the consumer that turns
 * a wrong answer into a wrong number on screen. The one rule that matters more than
 * any individual size: an unknown model answers `undefined`, so the gauge hides its
 * ratio instead of dividing by a guess.
 *
 * The ids below are the ones this codebase actually produces — `describeProviders`
 * defaults, the client model catalog's slugs, and the Agent SDK's aliases.
 */
describe('contextWindowFor', () => {
  it('knows the Claude family, by id and by alias', () => {
    expect(contextWindowFor('ai-sdk', 'claude-sonnet-4-5')).toBe(CLAUDE_CONTEXT_WINDOW);
    // Bedrock's inference-profile ids carry the same model name.
    expect(contextWindowFor('ai-sdk', 'anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(200_000);
    for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) {
      expect(contextWindowFor('dev-claude', alias)).toBe(200_000);
    }
    // AN ALIAS WITH THE CATALOG'S TIER MARKER, which is the literal value `auto`
    // sends for its opus tier: before `isClaudeAlias` learned to strip a trailing
    // `[…]`, `opus[1m]` matched neither "claude" nor a bare alias, reached no rule
    // at all, and this answered `undefined` for the one value that names 1M.
    expect(contextWindowFor('dev-claude', 'opus[1m]')).toBe(CLAUDE_1M_CONTEXT_WINDOW);
    // And the stripping stops at aliases: `default` is still a name we cannot
    // size, because what it resolves to is the plan's business, not ours.
    expect(contextWindowFor('dev-claude', 'default')).toBeUndefined();
  });

  it('answers for the Claude sign-in even when NO model was requested', () => {
    // The Agent SDK resolves the sign-in's own default, and every model it can
    // resolve to has a 200k window — so an empty model is not an unknown one here.
    expect(contextWindowFor('dev-claude', '')).toBe(CLAUDE_CONTEXT_WINDOW);
    expect(contextWindowFor('dev-claude', undefined)).toBe(CLAUDE_CONTEXT_WINDOW);
  });

  // -- the long-context tier ------------------------------------------------
  //
  // A Claude subscription run can be on a 1M window, and the run does not always
  // SAY so — the tier went GA, and a GA tier announces itself through neither of
  // the two signals below. THREE signals reach this registry and each on its own
  // has to be enough: the beta and the marker on the served id (both LEGACY, kept
  // for older runs), and the id we REQUESTED (`opus[1m]`), which is the only one a
  // live run still shows. A turn that reported 293k on what we called a 200k
  // window is what sent us looking; a turn that showed `97% (194k/200k)` on a
  // 1,000,000-token window is what added the third.

  it('reads the 1M tier off the CONCRETE model id', () => {
    // LEGACY, AND KEPT FOR THE SAME REASON THE BETA IS. A served id that DOES name
    // the tier still means the tier, and refusing to read it would gain nothing —
    // but it is no longer what a live run looks like: the SDK strips the marker
    // from the id it serves (0 of 24747 local transcript ids carry `[1m]`), so the
    // requested id is what the tier is actually read from now.
    expect(contextWindowFor('dev-claude', 'claude-opus-5[1m]')).toBe(CLAUDE_1M_CONTEXT_WINDOW);
    expect(CLAUDE_1M_CONTEXT_WINDOW).toBe(1_000_000);
    // Other punctuations of the same marker, so a differently-formatted id is not
    // silently read as an ordinary 200k model.
    expect(contextWindowFor('dev-claude', 'claude-sonnet-5-1m')).toBe(CLAUDE_1M_CONTEXT_WINDOW);
    // The marker must STAND ALONE — a version fragment that merely contains the
    // characters is not a tier.
    expect(contextWindowFor('dev-claude', 'claude-sonnet-41m-preview')).toBe(CLAUDE_CONTEXT_WINDOW);
  });

  it('reads the 1M tier off the betas the RUN negotiated', () => {
    // LEGACY, AND KEPT ON PURPOSE. The Agent SDK's init message reports what the
    // CLI actually enabled; a live run on the GA tier sends no `betas` array at
    // all, so this signal now only covers CLIs old enough to still negotiate the
    // beta. It must keep answering for those.
    expect(CONTEXT_1M_BETA).toBe('context-1m-2025-08-07');
    expect(
      contextWindowFor('dev-claude', 'claude-opus-5', { betas: [CONTEXT_1M_BETA] }),
    ).toBe(CLAUDE_1M_CONTEXT_WINDOW);
    // …including for the sign-in default, which names no model at all.
    expect(contextWindowFor('dev-claude', '', { betas: [CONTEXT_1M_BETA] })).toBe(
      CLAUDE_1M_CONTEXT_WINDOW,
    );
  });

  it('does NOT apply the 1M tier to a run that did not report it', () => {
    // The mirror-image error: reporting 1M by default would understate fullness on
    // every ordinary turn. Absence of the signal means the ordinary window.
    expect(contextWindowFor('dev-claude', 'claude-opus-5')).toBe(CLAUDE_CONTEXT_WINDOW);
    expect(contextWindowFor('dev-claude', 'claude-opus-5', { betas: [] })).toBe(
      CLAUDE_CONTEXT_WINDOW,
    );
    expect(
      contextWindowFor('dev-claude', 'claude-opus-5', { betas: ['some-other-beta'] }),
    ).toBe(CLAUDE_CONTEXT_WINDOW);
    // …and the beta says nothing about a NON-Claude model.
    expect(contextWindowFor('ai-sdk', 'gpt-4o', { betas: [CONTEXT_1M_BETA] })).toBe(128_000);
  });

  it('reads the 1M tier off the id we REQUESTED, when the served id is the same model', () => {
    // THE LIVE SHAPE (verified twice against @anthropic-ai/claude-agent-sdk): we
    // ask for `claude-opus-5[1m]`, the init message echoes the marker back, and
    // every assistant step then reports `claude-opus-5` WITHOUT it. No `betas`
    // array is sent at all. So the served id — the one this registry is handed —
    // names a 200k model while the run is on 1M, and the only surviving statement
    // about the tier is what we asked for.
    expect(
      contextWindowFor('dev-claude', 'claude-opus-5', { requested: 'claude-opus-5[1m]' }),
    ).toBe(CLAUDE_1M_CONTEXT_WINDOW);
    // The catalog's ALIAS form of the same request, which is what `auto` sends.
    expect(contextWindowFor('dev-claude', 'claude-opus-5', { requested: 'opus[1m]' })).toBe(
      CLAUDE_1M_CONTEXT_WINDOW,
    );
    // …and the sign-in default, which names no served model at all.
    expect(contextWindowFor('dev-claude', '', { requested: 'opus[1m]' })).toBe(
      CLAUDE_1M_CONTEXT_WINDOW,
    );
  });

  it('does NOT carry a requested 1M tier onto a DIFFERENT model', () => {
    // THE REFUSAL FALLBACK, which is why this is a same-model check and not a
    // `max(served, requested)`: the CLI can swap the model mid-turn, and a turn
    // that ended up on haiku is on haiku's 200k window no matter what we asked
    // for. Taking the larger of the two would overstate the window by five times
    // on exactly the turn that changed under us.
    expect(
      contextWindowFor('dev-claude', 'claude-haiku-4-5-20251001', { requested: 'opus[1m]' }),
    ).toBe(CLAUDE_CONTEXT_WINDOW);
    expect(
      contextWindowFor('dev-claude', 'claude-sonnet-5', { requested: 'claude-opus-5[1m]' }),
    ).toBe(CLAUDE_CONTEXT_WINDOW);
    // A request with no marker says nothing about the tier — the catalog names the
    // two opus tiers as two different values, and GA did not merge them.
    expect(contextWindowFor('dev-claude', 'claude-opus-5', { requested: 'opus' })).toBe(
      CLAUDE_CONTEXT_WINDOW,
    );
    // And a non-Claude served id is sized by its own family, never by our request.
    expect(contextWindowFor('ai-sdk', 'gpt-4o', { requested: 'opus[1m]' })).toBe(128_000);
  });

  it('exposes the same-model rule as its own predicate', () => {
    // Asserted separately from the lookup because the rule is the load-bearing
    // half: it is what keeps a requested tier from being carried onto whatever
    // model the run actually ended on.
    expect(requestedOneMTier('claude-opus-5[1m]', 'claude-opus-5')).toBe(true);
    expect(requestedOneMTier('opus[1m]', 'claude-opus-5')).toBe(true);
    expect(requestedOneMTier('claude-fable-5-1[1m]', 'claude-fable-5-1')).toBe(true);
    // An empty served id names no OTHER model, so the request still stands (the
    // caller gates this on the Claude engine, where an empty id has a default).
    expect(requestedOneMTier('opus[1m]', '')).toBe(true);
    expect(requestedOneMTier('opus[1m]', undefined)).toBe(true);
    // A different model, a request with no marker, and no request at all.
    expect(requestedOneMTier('opus[1m]', 'claude-haiku-4-5-20251001')).toBe(false);
    expect(requestedOneMTier('claude-opus-5[1m]', 'claude-sonnet-5')).toBe(false);
    expect(requestedOneMTier('opus', 'claude-opus-5')).toBe(false);
    expect(requestedOneMTier(undefined, 'claude-opus-5')).toBe(false);
    expect(requestedOneMTier('default', 'claude-opus-5')).toBe(false);
  });

  it('still answers UNDEFINED for the "default" row the Agent SDK offers', () => {
    // The row the model picker shows as "let Claude pick". It is a real, common
    // `model` value and it names no window, which is exactly why the engines now
    // report the CONCRETE id — the registry has no way to size this one and must
    // not pretend otherwise.
    expect(contextWindowFor('dev-claude', 'default')).toBeUndefined();
  });

  it('treats an empty model on any OTHER engine as unknown', () => {
    // A provider's default could be anything; guessing it is exactly what the
    // undefined answer exists to prevent.
    expect(contextWindowFor('ai-sdk', '')).toBeUndefined();
    expect(contextWindowFor('ai-sdk', undefined)).toBeUndefined();
  });

  it('knows the OpenAI families, and does not let 4.1 fall through to 4o', () => {
    expect(contextWindowFor('ai-sdk', 'gpt-4o')).toBe(128_000);
    expect(contextWindowFor('ai-sdk', 'gpt-4o-mini')).toBe(128_000);
    expect(contextWindowFor('ai-sdk', 'gpt-4.1')).toBe(1_047_576);
    expect(contextWindowFor('ai-sdk', 'gpt-4.1-mini')).toBe(1_047_576);
    // GPT-5 and the ChatGPT/codex slugs: 272k INPUT (the quoted 400k is the total,
    // of which 128k is reserved for output — this gauge measures input).
    expect(contextWindowFor('ai-sdk', 'gpt-5')).toBe(272_000);
    expect(contextWindowFor('ai-sdk', 'gpt-5.6-sol')).toBe(272_000);
    expect(contextWindowFor('ai-sdk', 'gpt-5.4-mini')).toBe(272_000);
    // o-series reasoning models.
    expect(contextWindowFor('ai-sdk', 'o3')).toBe(200_000);
    expect(contextWindowFor('ai-sdk', 'o4-mini')).toBe(200_000);
  });

  it('knows Gemini', () => {
    expect(contextWindowFor('ai-sdk', 'gemini-2.5-pro')).toBe(1_048_576);
    expect(contextWindowFor('ai-sdk', 'gemini-1.5-flash')).toBe(1_048_576);
  });

  it('is case- and whitespace-insensitive, because model ids arrive as typed', () => {
    expect(contextWindowFor('ai-sdk', '  Claude-Sonnet-4-5 ')).toBe(200_000);
  });

  it('answers UNDEFINED for anything it does not know — the load-bearing case', () => {
    expect(contextWindowFor('ai-sdk', 'my-azure-deployment')).toBeUndefined();
    expect(contextWindowFor('ai-sdk', 'llama-3.1-70b')).toBeUndefined();
    expect(contextWindowFor('ai-sdk', 'mistral-large')).toBeUndefined();
  });

  it('keeps the compaction fallback separate from the gauge answer', () => {
    // The gauge hides its ratio for an unknown model; compaction cannot hide, so it
    // folds against the smallest window any supported provider ships.
    expect(FALLBACK_CONTEXT_WINDOW).toBe(128_000);
    expect(contextWindowFor('ai-sdk', 'llama-3.1-70b') ?? FALLBACK_CONTEXT_WINDOW).toBe(128_000);
  });
});

/**
 * THE PRECEDENCE THE GAUGE ACTUALLY USES — a size the RUN reported beats
 * anything the registry above can infer.
 *
 * The bug that put this here: a live Agent SDK 0.3.215 turn served
 * `claude-fable-5` on a 1,000,000-token window with NO `context-1m-2025-08-07`
 * beta and NO `[1m]` marker on the id — the long-context tier had gone GA, so
 * both signals the registry reads were simply absent — and the status bar
 * reported `64% (127k/200k)`. The result message said `contextWindow: 1000000`
 * the whole time.
 *
 * So the rule under test is an ORDERING, not a lookup: reported wins, inference
 * is the fallback, and the fallback's own behaviour must not have moved.
 */
describe('resolveContextWindow', () => {
  it('prefers the window the RUN reported over anything inferred', () => {
    // The live case, exactly: a model the registry sizes at 200k, on a run that
    // reported 1M and announced the tier in no other way.
    expect(
      resolveContextWindow({
        engineId: 'dev-claude',
        reportedWindow: 1_000_000,
        contextModel: 'claude-fable-5',
        modelLabel: 'default',
      }),
    ).toBe(1_000_000);
    // …and it wins over a registry answer that DISAGREES in the other direction,
    // so the reported figure is genuinely the source and not a coincidence.
    expect(
      resolveContextWindow({
        engineId: 'ai-sdk',
        reportedWindow: 64_000,
        contextModel: 'gemini-2.5-pro',
        modelLabel: 'gemini-2.5-pro',
      }),
    ).toBe(64_000);
    // The reported size also answers where the registry knows NOTHING — the case
    // that used to leave the client estimating from the model's family.
    expect(
      resolveContextWindow({
        engineId: 'ai-sdk',
        reportedWindow: 400_000,
        contextModel: 'my-azure-deployment',
        modelLabel: 'my-azure-deployment',
      }),
    ).toBe(400_000);
  });

  it('falls back to the registry when the run reported NO window', () => {
    // Every AI-SDK backend, and any Agent SDK turn that ended before its result.
    // The chain below must behave exactly as it did before the reported field
    // existed — the served id first, the requested label second.
    expect(
      resolveContextWindow({
        engineId: 'dev-claude',
        contextModel: 'claude-opus-5',
        modelLabel: 'default',
      }),
    ).toBe(CLAUDE_CONTEXT_WINDOW);
    // The served id is `default` (nameable but unsizeable), so the label carries it.
    expect(
      resolveContextWindow({
        engineId: 'ai-sdk',
        contextModel: 'default',
        modelLabel: 'gpt-4o',
      }),
    ).toBe(128_000);
    // The betas still reach the registry, so a run that DID announce the tier the
    // old way is sized the old way.
    expect(
      resolveContextWindow({
        engineId: 'dev-claude',
        contextModel: 'claude-opus-5',
        modelLabel: 'default',
        betas: [CONTEXT_1M_BETA],
      }),
    ).toBe(CLAUDE_1M_CONTEXT_WINDOW);
    // …and an unknown model is still UNDEFINED rather than a guess.
    expect(
      resolveContextWindow({
        engineId: 'ai-sdk',
        contextModel: 'llama-3.1-70b',
        modelLabel: 'llama-3.1-70b',
      }),
    ).toBeUndefined();
  });

  it('takes the REQUESTED tier when the served id is the same model', () => {
    // THE BUG THIS ROUND. A live 1M run reports `claude-opus-5` on its assistant
    // steps, sends no `betas`, and — when a subagent is also billed — used to
    // report no window either. The gauge read `97% (194k/200k)` with no `~` marker
    // and offered to continue in a new tab, on a window five times larger. The id
    // we ASKED for still carries the tier, and it is now read.
    expect(
      resolveContextWindow({
        engineId: 'dev-claude',
        contextModel: 'claude-opus-5',
        modelLabel: 'claude-opus-5[1m]',
      }),
    ).toBe(1_000_000);
    // The alias form `auto` sends for the same tier.
    expect(
      resolveContextWindow({
        engineId: 'dev-claude',
        contextModel: 'claude-opus-5',
        modelLabel: 'opus[1m]',
      }),
    ).toBe(1_000_000);
    // THE GUARD: a refusal fallback swapped the run down to haiku, so the window
    // is haiku's however loudly the request named a tier. This is why the rule is
    // a same-model check rather than the larger of the two answers.
    expect(
      resolveContextWindow({
        engineId: 'dev-claude',
        contextModel: 'claude-haiku-4-5-20251001',
        modelLabel: 'opus[1m]',
      }),
    ).toBe(CLAUDE_CONTEXT_WINDOW);
    // A plain opus turn stays 200k: the catalog names the two tiers as two
    // different values, and the tier going GA did not merge them.
    expect(
      resolveContextWindow({
        engineId: 'dev-claude',
        contextModel: 'claude-opus-5',
        modelLabel: 'claude-opus-5',
      }),
    ).toBe(CLAUDE_CONTEXT_WINDOW);
    // And a window the RUN reported still outranks the requested tier — the
    // measurement is first in the precedence, not second.
    expect(
      resolveContextWindow({
        engineId: 'dev-claude',
        reportedWindow: 200_000,
        contextModel: 'claude-opus-5',
        modelLabel: 'claude-opus-5[1m]',
      }),
    ).toBe(200_000);
  });

  it('ignores a reported window that is not a size', () => {
    // A zero or a NaN forwarded from a backend would divide the gauge by nothing.
    // These fall THROUGH to the inference rather than poisoning the answer.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveContextWindow({
          engineId: 'dev-claude',
          reportedWindow: bad,
          contextModel: 'claude-opus-5',
          modelLabel: 'default',
        }),
      ).toBe(CLAUDE_CONTEXT_WINDOW);
    }
  });
});

/**
 * WHICH `modelUsage` ENTRY THE REPORTED WINDOW COMES FROM — the Agent SDK engine's
 * side of the same fix. Asserted here, from the shell, for the same reason the
 * registry is: this is what decides the number on screen, and it must be
 * checkable without a live SDK run.
 */
describe('reportedContextWindow', () => {
  const usage = (contextWindow: number) => ({
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow,
    maxOutputTokens: 64_000,
  });

  it('takes the entry keyed by the model that produced the reading', () => {
    expect(
      reportedContextWindow(
        { 'claude-fable-5': usage(1_000_000), 'claude-haiku-4-5': usage(200_000) },
        'claude-fable-5',
      ),
    ).toBe(1_000_000);
  });

  it('matches the key that only differs by its TIER SUFFIX — the live shape', () => {
    // THE REGRESSION, verified twice against a live @anthropic-ai/claude-agent-sdk
    // run: `modelUsage` is keyed by the id we REQUESTED (`claude-opus-5[1m]`,
    // marker kept) while the assistant steps report `claude-opus-5` (marker
    // stripped), so the exact lookup never matched. A single-model turn survived
    // on the sole-entry rule by accident; the moment a Task subagent is billed too
    // — which naby's own cheap-subagent routing made ordinary — there are two keys
    // and the window was dropped entirely. The gauge then read `97% (194k/200k)`
    // on a 1,000,000-token window.
    expect(
      reportedContextWindow(
        { 'claude-opus-5[1m]': usage(1_000_000), 'claude-haiku-4-5-20251001': usage(200_000) },
        'claude-opus-5',
      ),
    ).toBe(1_000_000);
    // The single-model turn, which both this rule and the sole-entry rule answer.
    expect(reportedContextWindow({ 'claude-opus-5[1m]': usage(1_000_000) }, 'claude-opus-5')).toBe(
      1_000_000,
    );
    // Suffix on the reported side instead of the key's, since which side carries
    // the marker is the SDK's business and has already moved once.
    expect(reportedContextWindow(
      { 'claude-opus-5': usage(1_000_000), 'claude-haiku-4-5-20251001': usage(200_000) },
      'claude-opus-5[1m]',
    )).toBe(1_000_000);
  });

  it('will not choose between two keys that normalize to the SAME model', () => {
    // Synthetic — no live run has produced two tiers of one model in one result —
    // but it is the ambiguity the tier-stripped match creates, and it answers the
    // same way the sole-entry rule does: two candidates and nothing to pick
    // between them is `undefined`, never a coin flip.
    expect(
      reportedContextWindow(
        { 'claude-opus-5[1m]': usage(1_000_000), 'claude-opus-5[2m]': usage(2_000_000) },
        'claude-opus-5',
      ),
    ).toBeUndefined();
  });

  it('takes a SOLE entry when the exact key is missing', () => {
    // A turn that ended before any assistant message named an id, or an id
    // reported in a form the result keys differently. One entry leaves nothing to
    // choose between, so it is the run's window by construction.
    expect(reportedContextWindow({ 'claude-fable-5': usage(1_000_000) }, undefined)).toBe(
      1_000_000,
    );
    expect(reportedContextWindow({ 'claude-fable-5': usage(1_000_000) }, 'claude-opus-5')).toBe(
      1_000_000,
    );
  });

  it('answers UNDEFINED rather than picking between models it cannot attribute', () => {
    // Two entries and no matching key: the numerator belongs to ONE of these
    // windows and nothing here says which. Guessing is the bug, not the fix.
    expect(
      reportedContextWindow(
        { 'claude-fable-5': usage(1_000_000), 'claude-haiku-4-5': usage(200_000) },
        'claude-opus-5',
      ),
    ).toBeUndefined();
    // Nothing reported at all — an older CLI, or a backend that has no such field.
    expect(reportedContextWindow(undefined, 'claude-fable-5')).toBeUndefined();
    expect(reportedContextWindow({}, 'claude-fable-5')).toBeUndefined();
  });

  it('rejects a non-size, so the caller falls back instead of dividing by nothing', () => {
    expect(reportedContextWindow({ 'claude-fable-5': usage(0) }, 'claude-fable-5')).toBeUndefined();
    expect(
      reportedContextWindow({ 'claude-fable-5': usage(Number.NaN) }, 'claude-fable-5'),
    ).toBeUndefined();
  });
});
