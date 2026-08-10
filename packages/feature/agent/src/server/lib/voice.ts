// packages/feature/agent/src/server/lib/voice.ts
//
// THE NABY LAYER'S MODEL CALL (Phase 3, P3-M14a — specs/naby-voice-layer.md §8).
//
// The runtime owns the RULES — what counts as a deviation, when a rewrite is
// worth a call, whether the result may be shown (runtime/voice.ts, pure). This
// owns the four things only the shell can do: read the style fingerprint, drive a
// model, keep the control markers out of the model's reach, and write down what it
// spent.
//
// ONE INSTANCE PER TURN. The per-turn cap (§5) is a counter, and a counter that
// outlived its turn would be a cap on the app rather than on the turn. The engine
// builds one of these before its autonomy loop and hands it to every step, so a
// twenty-step run gets three rewrites in total and not three per step.
//
// IT DRIVES THE ENGINE DIRECTLY, NOT `runTurn` — the same choice, for the same
// reason, as the reflection judge and the handoff summarizer: `runTurn` would
// append this prompt and its answer to the user's own transcript and file a usage
// row against their conversation. The user asked a question; they did not ask for
// "rewrite this more like me" to appear in the conversation as a turn they took.
// The cost is not hidden by that, it is MOVED — §7.1 puts the model and the tokens
// in the activity log, which is the one place naby's invisible spending is
// countable.
//
// IT CANNOT FAIL A TURN. Every path returns `req.text`: no backend, a timeout, a
// provider error, a rewrite that failed verification, an unreadable setting, a
// bug. The port contract says so (runtime/engine.ts `VoicePort`) and the whole
// body is wrapped to make it true even for the case nobody thought of. §6: this is
// the layer that is not allowed to be the reason an answer does not arrive.

import {
  buildVoicePrompt,
  detectVoiceDeviation,
  logActivity,
  parseStyleFingerprint,
  shouldRestyle,
  stripNonProse,
  STYLE_FINGERPRINT_KEY,
  verifyVoiceRewrite,
  voiceRewriteMode,
  voiceUserLanguage,
  VOICE_MIN_PROSE_CHARS,
  VOICE_TIMEOUT_MS,
  VOICE_TURN_REWRITE_CAP,
  type GrowthStage,
  type StyleFingerprint,
  type Usage,
  type VoiceDeviation,
  type VoicePort,
  type VoiceVerifyOptions,
} from '../../../../../../../dist/naby-runtime.mjs';
// The autonomy protocol's markers, IMPORTED rather than respelled. A second copy
// of `[[DONE]]` in this file would be a second copy of the string the autonomy
// loop stops on, and the day one of them changed the loop would stop being able to
// stop.
import { DONE_MARKER, VERIFIED_MARKER_PREFIX } from './autonomy';
import type { JudgeBackend } from './reflection';

/**
 * The settings row the per-reason totals live in (§7).
 *
 * OWNED HERE. It is written by this module and read by this module and by the
 * engine's preventive switch; the runtime never sees it, because a count of how
 * often naby had to correct itself is an observation about a deployment, not a
 * rule about text.
 */
export const VOICE_STATS_KEY = 'voice.stats';

/** Why a rewrite happened: the measured deviation, or `stage` for the pupa /
 *  butterfly rule that restyles without one (§5). */
export type VoiceRewriteReason = VoiceDeviation | 'stage';

/** The running totals in `voice.stats`. Counts and one timestamp — nothing here
 *  is text, so the row is safe to show in the settings panel as it stands. */
export type VoiceStats = {
  rewrites: number;
  byReason: Partial<Record<VoiceRewriteReason, number>>;
  lastAt: number;
};

/** The narrow slice of the store this needs — the same trick `ReflectionStore`
 *  uses, so a test hands it a plain object and the production `Store` satisfies it
 *  structurally. */
export interface VoiceStore {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
}

export type VoicePortDeps = {
  store: VoiceStore;
  /**
   * The growth stage this turn's agent has EARNED — the left column of §5's table.
   * Undefined means the ledger could not be established (or this turn has no
   * growth subject), which the runtime reads as the narrow rule: correct what is
   * measurably wrong and spend nothing on what is not.
   */
  stage: GrowthStage | undefined;
  /** The one-line style profile, when this turn is already injecting one. Passed
   *  in rather than re-read: the turn has already paid for that lookup, and two
   *  reads could disagree if the sweep landed between them. */
  styleLine?: string;
  /**
   * Whether this turn may LEARN (`canCaptureMemory`). It gates the totals and
   * nothing else — §2 principle 5: the switches decide what naby records, never
   * whether it uses what it already knows, so a temporary session still gets its
   * voice corrected and simply leaves no trace of having done so.
   */
  learningAllowed: boolean;
  /**
   * The USER's own words for the whole run.
   *
   * WHY IT IS NOT SIMPLY `req.userText`. On an autonomy step 2+ the turn's user
   * message is the harness saying "continue toward the goal" — English, and
   * written by us. Judging the answer's language against that would report every
   * Korean continuation as a language deviation and then translate the answer into
   * the harness's language. The engine knows which text actually drove the run
   * (`turnText`, constant across steps), so it passes it; `req.userText` is the
   * fallback for callers with no such notion, and on step 1 the two are identical.
   */
  turnText?: string;
  /** Test seam: which backend answers. Production resolves the reflection judge's
   *  backend, imported rather than re-derived (§8). */
  resolveBackend?: () => Promise<JudgeBackend | undefined>;
  /** Test seam: the clock the totals are stamped with. */
  now?: () => number;
};

// ---------------------------------------------------------------------------
// The control markers (§2 principle 4)
// ---------------------------------------------------------------------------

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `[[VERIFIED: ...]]` — prefix-anchored, to the first `]]`, case-insensitive for
 *  the same reason `sawVerifiedMarker` is: a model that lowercases the marker is
 *  still making the claim. */
const VERIFIED_RE = new RegExp(`${escapeForRegExp(VERIFIED_MARKER_PREFIX)}[^\\]]*\\]\\]`, 'gi');
const DONE_RE = new RegExp(escapeForRegExp(DONE_MARKER), 'gi');

/**
 * A fenced block, or an inline-code span — the two places where a marker is a
 * QUOTATION of the protocol rather than a use of it.
 *
 * An unterminated fence runs to the end of the text on purpose: a truncated
 * answer's tail is still code, and a marker in it is still a sample.
 */
const CODE_SPAN_RE = /(?:```|~~~)[\s\S]*?(?:```|~~~|$)|`[^`\n]*`/g;

type MarkerSplit = { body: string; verified: string[]; done: boolean };

/**
 * Take the protocol markers OUT of the text before a model ever sees it.
 *
 * TWO REASONS, and the second is the load-bearing one. First, a marker is not a
 * sentence: asked to restyle `[[DONE]]` a model will translate it, quote it, or
 * explain it. Second, the autonomy loop's stop decision reads the marker out of
 * the text this function's counterpart re-attaches — so if a rewrite could lose
 * `[[DONE]]`, an autonomous run would never stop. Stripping and re-attaching makes
 * that impossible by construction rather than by hoping the verifier catches it.
 *
 * CODE IS NOT SCANNED (review defect 7). An answer that EXPLAINS the autonomy
 * protocol — which naby is asked for regularly, since it is naby's own protocol —
 * contains `[[DONE]]` inside a code block. This function used to cut it out of the
 * block and re-attach it as the answer's last line: the sample lost the line it
 * was demonstrating, the block came back different from the way the model wrote
 * it, and the loop was told the step had declared itself done because of a line in
 * a code sample. That made this layer the single path in the app that rewrites
 * code, which is the one thing §2 forbids it outright.
 *
 * So the text is walked in segments and only the ones OUTSIDE code are scanned.
 * The code segments are copied through untouched — literally the same substrings,
 * in the same order.
 */
export function splitProtocolMarkers(text: string): MarkerSplit {
  const verified: string[] = [];
  let done = false;
  const out: string[] = [];
  let cursor = 0;

  const scan = (chunk: string): string => {
    const found = chunk.match(VERIFIED_RE) ?? [];
    verified.push(...found);
    if (DONE_RE.test(chunk)) done = true;
    // Both regexes are /g, so `lastIndex` survives a `test`. Reset before reuse.
    DONE_RE.lastIndex = 0;
    return chunk.replace(VERIFIED_RE, '').replace(DONE_RE, '');
  };

  CODE_SPAN_RE.lastIndex = 0;
  for (let m = CODE_SPAN_RE.exec(text); m !== null; m = CODE_SPAN_RE.exec(text)) {
    out.push(scan(text.slice(cursor, m.index)));
    out.push(m[0]);
    cursor = m.index + m[0].length;
  }
  out.push(scan(text.slice(cursor)));

  const body = out
    .join('')
    // The markers usually sit on lines of their own; removing them leaves the
    // blank lines behind, which would then count against the length ratio.
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { body, verified, done };
}

/** Put them back where the protocol says they go (lib/autonomy.ts): the
 *  verification line, then `[[DONE]]` alone on the last line. */
export function reattachProtocolMarkers(body: string, split: MarkerSplit): string {
  const parts = [body.trimEnd(), ...split.verified];
  if (split.done) parts.push(DONE_MARKER);
  return parts.filter((part) => part.length > 0).join('\n');
}

// ---------------------------------------------------------------------------
// The totals (§7)
// ---------------------------------------------------------------------------

/** Read the totals. An unreadable or malformed row reads as EMPTY rather than as
 *  a failure: this number decides whether one extra line is injected into a
 *  prompt, and failing a turn over it would be absurd. */
export function readVoiceStats(store: Pick<VoiceStore, 'getSetting'>): VoiceStats {
  const empty: VoiceStats = { rewrites: 0, byReason: {}, lastAt: 0 };
  let raw: string | undefined;
  try {
    raw = store.getSetting(VOICE_STATS_KEY);
  } catch {
    return empty;
  }
  if (typeof raw !== 'string' || raw.trim().length === 0) return empty;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return empty;
    const row = parsed as Record<string, unknown>;
    const byReason: VoiceStats['byReason'] = {};
    const source = (row.byReason ?? {}) as Record<string, unknown>;
    for (const key of ['language', 'endings', 'length', 'stage'] as const) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        byReason[key] = Math.floor(value);
      }
    }
    return {
      rewrites:
        typeof row.rewrites === 'number' && Number.isFinite(row.rewrites)
          ? Math.max(0, Math.floor(row.rewrites))
          : 0,
      byReason,
      lastAt: typeof row.lastAt === 'number' && Number.isFinite(row.lastAt) ? row.lastAt : 0,
    };
  } catch {
    return empty;
  }
}

/** Add one to the totals. Never throws — a settings write that fails costs a
 *  count, never the answer it was counting. */
function bumpVoiceStats(store: VoiceStore, reason: VoiceRewriteReason, at: number): void {
  try {
    const stats = readVoiceStats(store);
    const next: VoiceStats = {
      rewrites: stats.rewrites + 1,
      byReason: { ...stats.byReason, [reason]: (stats.byReason[reason] ?? 0) + 1 },
      lastAt: at,
    };
    store.setSetting(VOICE_STATS_KEY, JSON.stringify(next));
  } catch (e) {
    console.warn(`[voice] totals not updated: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

function readFingerprint(store: Pick<VoiceStore, 'getSetting'>): StyleFingerprint | undefined {
  try {
    return parseStyleFingerprint(store.getSetting(STYLE_FINGERPRINT_KEY));
  } catch {
    return undefined;
  }
}

/**
 * ONE rewrite call: no tools, a deny-all gate, its own timeout, and the turn's own
 * abort signal wired to it.
 *
 * The shape is `modelHandoffSummarizer`'s, deliberately unchanged — same
 * `engine.run` with an empty toolset, same belt-and-braces gate (it matters most
 * on the Agent SDK backend, whose built-ins are live unless something stops them),
 * same timeout-plus-signal pairing. Three background calls that look alike are
 * three calls a reader can check at a glance.
 */
async function callBackend(
  backend: JudgeBackend,
  prompt: { system: string; user: string },
  signal: AbortSignal,
): Promise<{ text: string; usage: Usage | undefined; model: string | undefined }> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);

  let text = '';
  let usage: Usage | undefined;
  let model: string | undefined = backend.model.model;
  try {
    for await (const event of backend.engine.run({
      model: backend.model,
      messages: [{ role: 'user', content: prompt.user }],
      system: prompt.system,
      toolSchemas: [],
      gate: async () => ({
        behavior: 'deny' as const,
        reason: 'the naby layer rewrites text and runs without tools',
      }),
      executors: {},
      signal: controller.signal,
    })) {
      if (event.kind === 'init' && event.model) model = event.model;
      else if (event.kind === 'text' && event.role === 'assistant' && !event.partial) {
        text += event.text;
      } else if (event.kind === 'result') {
        usage = event.usage;
        if (event.contextModel) model = event.contextModel;
      }
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
  return { text, usage, model };
}

/**
 * Build this turn's naby layer.
 *
 * THE ORDER OF THE STEPS IS THE COST CONTROL. Markers off, fingerprint read,
 * deviation measured, stage consulted — all of it free — and only then is a
 * backend resolved and a model called. An egg-stage turn whose answer is already
 * in the user's voice costs one settings read and nothing else, which is what
 * makes "the layer is always on" (§3) affordable.
 */
export function createVoicePort(deps: VoicePortDeps): VoicePort {
  // The per-turn cap counts CALLS, not adoptions (§5: "재작성 호출에는 턴당
  // 상한"). A rewrite that fails verification was still paid for, so counting only
  // the successes would let a bad turn make unlimited calls and report having made
  // none.
  let calls = 0;
  // Resolved once per turn: credential resolution is a real lookup, and it cannot
  // change between two steps of the same run. `undefined` is cached too — "there
  // is no backend on this machine" is just as stable an answer as a backend.
  let backendResolved = false;
  let backend: JudgeBackend | undefined;
  const now = deps.now ?? Date.now;

  const resolve = async (): Promise<JudgeBackend | undefined> => {
    if (backendResolved) return backend;
    backendResolved = true;
    if (deps.resolveBackend) {
      backend = await deps.resolveBackend();
    } else {
      // Imported INSIDE the call, exactly as `modelHandoffSummarizer` does it:
      // /api/naby is imported by every settings request, and a static import would
      // drag the engine composition root into requests that only wanted to read a
      // checkbox. And it is `resolveJudgeBackend` itself, not a copy of it — a
      // second answer to "which backend can answer here" is how one feature ends
      // up believing a sign-in the other cannot see (§8).
      const { resolveJudgeBackend, selectedJudgeProviderId } = await import('./reflection');
      // THE USER'S PROVIDER, NOT WHICHEVER KEY SORTS FIRST. This layer runs on
      // EVERY turn, so it was the loudest voice in the defect
      // `resolveJudgeBackend` documents: a user who picked Gemini had a rewrite
      // billed to another account on every answer they read. `deps.store` is the
      // same store the turn read its own provider from, so the two cannot disagree.
      const providerId = selectedJudgeProviderId(deps.store);
      backend = await resolveJudgeBackend(providerId ? { providerId } : {});
    }
    return backend;
  };

  return {
    async render(req) {
      try {
        const split = splitProtocolMarkers(req.text);
        // A block that is nothing but markers has no prose to restyle, and
        // re-emitting it through the rest of this would risk moving them.
        if (split.body.trim().length === 0) return req.text;
        // NOTHING WORTH A CALL. The pupa/butterfly rule is "always" (§5), but
        // "always" was written about ANSWERS, and an autonomous step's closing
        // line is routinely "Step one done, continuing." or a bare command — a
        // handful of words with no surface to correct, which the detector already
        // refuses to judge for the same reason (`VOICE_MIN_PROSE_CHARS`). Without
        // this floor a twenty-step run would buy its whole rewrite budget polishing
        // progress notes, and the answer the user is actually reading would get
        // none of it.
        if (stripNonProse(split.body).length < VOICE_MIN_PROSE_CHARS) return req.text;

        const userText =
          deps.turnText && deps.turnText.trim().length > 0 ? deps.turnText : req.userText;
        const fingerprint = readFingerprint(deps.store);
        const deviation = detectVoiceDeviation({
          answer: split.body,
          userText,
          ...(fingerprint ? { fingerprint } : {}),
        });
        if (
          !shouldRestyle({
            stage: deps.stage,
            deviation,
            capReached: calls >= VOICE_TURN_REWRITE_CAP,
          })
        ) {
          return req.text;
        }

        const chosen = await resolve();
        if (!chosen) {
          console.warn('[voice] no backend can restyle (no API key, no Claude sign-in)');
          return req.text;
        }
        // Abort may have landed while the backend was being resolved.
        if (req.signal.aborted) return req.text;

        // WHICH JOB THIS CALL IS, decided HERE and used twice — once to write the
        // prompt and once to check what comes back. Both have to agree, and the one
        // thing that must not decide it is the rewrite itself (runtime
        // `VoiceRewriteMode`): a call made for an ending deviation is a restyle even
        // if the model hands back a translation, and it is refused for being one.
        const mode = voiceRewriteMode({ deviation, userText });
        // The target language for a translation comes from the USER's own words,
        // never from the answer. If this turn does not carry enough of them to say
        // (which `detectVoiceDeviation` would not have called a language deviation
        // anyway), the strict mode applies — the fallback direction is always the
        // one that refuses more.
        const target = mode === 'language' ? voiceUserLanguage(userText) : undefined;
        const verifyOptions: VoiceVerifyOptions =
          mode === 'language' && target !== undefined
            ? { mode: 'language', targetLanguage: target }
            : { mode: 'style' };

        calls += 1;
        const prompt = buildVoicePrompt({
          answer: split.body,
          userText,
          mode: verifyOptions.mode,
          ...(deps.styleLine ? { styleLine: deps.styleLine } : {}),
          ...(deviation ? { deviation } : {}),
        });

        let rewritten: Awaited<ReturnType<typeof callBackend>>;
        try {
          rewritten = await callBackend(chosen, prompt, req.signal);
        } catch (e) {
          console.warn(`[voice] call failed: ${e instanceof Error ? e.message : String(e)}`);
          return req.text;
        }

        const verdict = verifyVoiceRewrite(split.body, rewritten.text.trim(), verifyOptions);
        if (!verdict.ok) {
          // Not shown to the user (§6) and not silent either: a verifier that keeps
          // refusing is the signal that the prompt needs a line, and it is only
          // legible if the refusals are counted somewhere.
          // The MODE is named too: "refused for being 0.4x the original" reads very
          // differently depending on whether the call was a restyle or a
          // translation, and the difference is what a prompt fix would turn on.
          console.warn(`[voice] rewrite discarded (${verifyOptions.mode}) — ${verdict.reason}`);
          return req.text;
        }

        const reason: VoiceRewriteReason = deviation ?? 'stage';
        const finalText = reattachProtocolMarkers(rewritten.text.trim(), split);
        const at = now();
        // §7.1: the model and the tokens, because this call appears in neither the
        // transcript nor the usage table. `before`/`after` are the answer itself —
        // the log module masks and caps them like every other text field.
        logActivity('voice_rewrite', {
          sessionId: req.sessionId,
          reason,
          mode: verifyOptions.mode,
          ...(deps.stage ? { stage: deps.stage } : {}),
          ...(rewritten.model ? { model: rewritten.model } : {}),
          backend: chosen.label,
          before: req.text,
          after: finalText,
          ...(rewritten.usage
            ? {
                inputTokens: rewritten.usage.inputTokens ?? 0,
                outputTokens: rewritten.usage.outputTokens ?? 0,
                cachedInputTokens: rewritten.usage.cachedInputTokens ?? 0,
              }
            : {}),
        });
        // The totals are the LEARNING half (§7) and therefore the only half the
        // gates touch: a temporary session still had its voice corrected, and
        // leaves no record that it did.
        if (deps.learningAllowed) bumpVoiceStats(deps.store, reason, at);
        return finalText;
      } catch (e) {
        // The port contract is absolute: whatever happened, the user gets the
        // answer the model wrote.
        console.warn(`[voice] layer skipped: ${e instanceof Error ? e.message : String(e)}`);
        return req.text;
      }
    },
  };
}
