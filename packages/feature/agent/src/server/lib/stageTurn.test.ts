import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stageInstruction, stageProgressClause } from './stageTurn';
import {
  fastGrowthInstruction,
  INTERVIEW_SPARSE_BELOW,
  PRACTICE_MAX_PER_SITTING,
  type FastGrowthCounts,
} from './fastGrowth';
import {
  stageContract,
  stageProgressSummary,
  stageRefusalReason,
  type GrowthState,
} from '../../../../../../../dist/naby-runtime.mjs';

/**
 * P3-M12a — THE STAGE CAPABILITY CONTRACT (fast-evolution §3.1/§3.2).
 *
 * The engine-level proof that a refused call really does not run, and really does
 * not write a ledger row, lives in `src/spikes/spike-autonomy.ts` (h5/h6) where a
 * whole turn can be driven. This covers the pure half: what each stage may do,
 * what the refusal says, and that the honest-refusal instruction carries numbers
 * the ledger computed rather than numbers a model guessed.
 */

function state(over: Partial<GrowthState> = {}): GrowthState {
  return {
    stage: 'larva',
    percent: 40,
    lowerBound: 0.3,
    observedRate: 0.8,
    hits: 8,
    trials: 10,
    lifetimeHits: 8,
    lifetimeTrials: 10,
    needsMoreSamples: 0,
    coverage: 0,
    correctedAfter: 0,
    tripwires: 0,
    excluded: 0,
    brierSamples: 0,
    ...over,
  };
}

describe('stage contract — what each stage may do', () => {
  it('an egg and a larva may read and propose, and nothing else', () => {
    for (const stage of ['egg', 'larva'] as const) {
      expect(stageContract(stage)).toEqual({
        allowConsequential: false,
        allowIrreversible: false,
        maxSteps: 1,
      });
    }
  });

  it('a pupa may act reversibly, in up to three steps', () => {
    expect(stageContract('pupa')).toEqual({
      allowConsequential: true,
      // Irreversible stays off: a snapshotted file edit can be taken back, a
      // shell command and an outbound message cannot.
      allowIrreversible: false,
      maxSteps: 3,
    });
  });

  it('a butterfly has NO step number of its own — the user setting is the only limit', () => {
    // Undefined rather than a large number, deliberately: a number here would be
    // a second limit competing with `persona.autonomy.maxSteps`, and the two
    // would eventually disagree.
    expect(stageContract('butterfly')).toEqual({
      allowConsequential: true,
      allowIrreversible: true,
      maxSteps: undefined,
    });
  });
});

describe('stage contract — the refusal', () => {
  const refuse = (stage: 'egg' | 'larva' | 'pupa' | 'butterfly', toolName: string) =>
    stageRefusalReason({ toolName, stage, contract: stageContract(stage) });

  it('a larva may not write a file or run a command', () => {
    expect(refuse('larva', 'write_file')).toContain('Blocked by the stage contract');
    expect(refuse('larva', 'write_file')).toContain('larva');
    expect(refuse('larva', 'run_command')).toContain('Blocked by the stage contract');
    expect(refuse('larva', 'Bash')).toContain('Blocked by the stage contract');
  });

  it('a larva MAY read, search and use the tools that only propose', () => {
    // Reads are never refused: an agent that cannot look at anything cannot even
    // produce the draft the refusal promises instead.
    for (const tool of ['read_file', 'glob', 'grep', 'naby_remember', 'naby_checkin']) {
      expect(refuse('larva', tool)).toBeUndefined();
    }
  });

  it('a pupa may write (it is snapshotted) but may not run a command or send outward', () => {
    expect(refuse('pupa', 'write_file')).toBeUndefined();
    expect(refuse('pupa', 'edit_file')).toBeUndefined();
    expect(refuse('pupa', 'Write')).toBeUndefined();
    expect(refuse('pupa', 'run_command')).toContain('cannot be undone');
    expect(refuse('pupa', 'send_message')).toContain('cannot be undone');
  });

  it('a butterfly is refused nothing by the contract', () => {
    for (const tool of ['write_file', 'run_command', 'send_message', 'Bash']) {
      expect(refuse('butterfly', tool)).toBeUndefined();
    }
  });

  it('an undeclared MCP tool is refused fail-closed, and a declared read-only one is not', () => {
    const contract = stageContract('larva');
    // No annotation = consequential (the ledger's own fail-closed rule), so the
    // gate and the meter cannot disagree about what "consequential" means.
    expect(
      stageRefusalReason({ toolName: 'mcp__vendor__do_thing', stage: 'larva', contract }),
    ).toContain('Blocked by the stage contract');
    expect(
      stageRefusalReason({
        toolName: 'mcp__vendor__look',
        stage: 'larva',
        contract,
        signals: { readOnlyHint: true },
      }),
    ).toBeUndefined();
    // …unless the USER put an ask/deny rule on it, which outranks what the server
    // says about itself.
    expect(
      stageRefusalReason({
        toolName: 'mcp__vendor__look',
        stage: 'larva',
        contract,
        signals: { readOnlyHint: true, policyForcesConsequential: true },
      }),
    ).toContain('Blocked by the stage contract');
  });

  it('the refusal tells the model what to do instead, not just that it failed', () => {
    const reason = refuse('larva', 'write_file')!;
    expect(reason).toContain('Do not retry');
    expect(reason.toLowerCase()).toContain('draft');
  });
});

describe('stage progress — the numbers the honest refusal quotes', () => {
  it('below the minimum sample it is a COUNT of real answers still needed', () => {
    expect(stageProgressSummary(state({ stage: 'egg', trials: 2, needsMoreSamples: 3 }))).toEqual({
      kind: 'samples',
      remaining: 3,
    });
    expect(stageProgressClause({ kind: 'samples', remaining: 3 })).toContain('3 more check-in(s)');
    // And it says outright that practice cannot fill it — the one thing a user
    // running drills will otherwise assume.
    expect(stageProgressClause({ kind: 'samples', remaining: 3 })).toContain('practice');
  });

  it('once measured it is the gap between the bound and the next cut-off', () => {
    const larva = stageProgressSummary(state({ stage: 'larva', trials: 10, lowerBound: 0.3 }));
    expect(larva).toMatchObject({ kind: 'bound', lowerBound: 0.3, nextStage: 'pupa' });
    const pupa = stageProgressSummary(state({ stage: 'pupa', trials: 10, lowerBound: 0.5 }));
    expect(pupa).toMatchObject({ kind: 'bound', lowerBound: 0.5, nextStage: 'butterfly' });
    if (pupa.kind !== 'bound') return;
    expect(stageProgressClause(pupa)).toContain('0.50');
    expect(stageProgressClause(pupa)).toContain('0.60');
  });

  it('a butterfly has nothing above it', () => {
    expect(stageProgressSummary(state({ stage: 'butterfly', trials: 20 }))).toEqual({ kind: 'top' });
  });
});

describe('the stage instruction', () => {
  const larva = stageInstruction('larva', { kind: 'samples', remaining: 4 });

  it('states the stage, the protocol and the REAL number', () => {
    expect(larva).toContain('YOUR STAGE: larva');
    expect(larva).toContain('WHEN A REQUEST NEEDS MORE THAN YOU MAY DO');
    expect(larva).toContain('4 more check-in(s)');
  });

  it('tells the agent the limit is enforced, so it does not try and narrate a failure', () => {
    expect(larva).toContain('ENFORCES');
    expect(larva).toContain('Do not apologise at length');
  });

  it('a pupa is told what it MAY do, not only what it may not', () => {
    const pupa = stageInstruction('pupa', { kind: 'bound', lowerBound: 0.5, nextThreshold: 0.6, nextStage: 'butterfly' });
    expect(pupa).toContain('can be undone');
    expect(pupa).toContain('may NOT run commands');
  });

  it('never tells the agent how it is scored', () => {
    // Same rule as `checkinInstruction`: an agent told which behaviour lifts its
    // own number optimizes that number. It may know the stage it is AT and what
    // that permits; it may not know what moves it.
    const words = larva.toLowerCase();
    for (const leak of ['hit rate', 'wilson', 'percent', 'gauge', 'score']) {
      expect(words).not.toContain(leak);
    }
  });
});

describe('the fast-growth instruction (P3-M12b/c/d)', () => {
  const counts = (over: Partial<FastGrowthCounts> = {}): FastGrowthCounts => ({
    confirmedUserMemories: 0,
    practiceThisSession: 0,
    realCheckinsRemaining: 5,
    ...over,
  });
  /** A fresh sitting: nothing confirmed, nothing practised — the exact state the
   *  user was in when the session that produced no check-ins ran. */
  const sparse = fastGrowthInstruction(counts());
  const rich = fastGrowthInstruction(counts({ confirmedUserMemories: INTERVIEW_SPARSE_BELOW + 5 }));

  it('with sparse memory it opens by asking: one question, a bounded sitting, free skipping', () => {
    expect(sparse).toContain('ONE question per turn');
    expect(sparse).toContain('SKIPPING IS FREE');
    expect(sparse).toContain('naby_remember');
    // The claim it must never make.
    expect(sparse).toContain('never imply that answering');
  });

  /**
   * THE REGRESSION THIS MILESTONE EXISTS FOR (fast-evolution §3.3d).
   *
   * A real fast-growth session interviewed the user well — eight memories
   * proposed — and called `naby_checkin` exactly zero times, because with 8
   * confirmed facts the old instruction took the interview BRANCH and the
   * practice branch was unreachable. The growth report afterwards read 0/0, egg,
   * "5 more check-ins". So the property is not "the drill text exists somewhere";
   * it is that a sitting BELOW the sparse line is still told to run practice
   * check-ins, in the same conversation.
   */
  it('runs practice check-ins EVEN WHEN memory is sparse — the interview is part 1, not the job', () => {
    for (const [label, text] of [
      ['nothing known yet', sparse],
      ['eight facts, the real failing session', fastGrowthInstruction(counts({ confirmedUserMemories: 8 }))],
    ] as const) {
      expect(text, label).toContain('PART 2 — PRACTISE PREDICTING THEM');
      expect(text, label).toContain('COMMIT FIRST');
      expect(text, label).toContain('naby_checkin');
      expect(text, label).toContain('VARY THEM');
      // …and the handover between the parts is explicit, so the model does not
      // stop when the questions run out.
      expect(text, label).toContain('MOVE ON TO PART 2');
    }
  });

  it('states plainly that only check-ins move the stage, and that answers are memory only', () => {
    for (const text of [sparse, rich]) {
      expect(text).toContain('WHAT ACTUALLY MOVES YOUR STAGE');
      expect(text).toContain('becomes MEMORY and');
      expect(text).toContain('The only thing that moves it is a');
    }
  });

  it('with memory in hand it skips the questions and starts at the practice check-ins', () => {
    expect(rich).toContain('START AT PART 2');
    expect(rich).toContain('COMMIT FIRST');
    // No interview marching orders when there is nothing left to ask.
    expect(rich).not.toContain('ONE question per turn');
  });

  it('carries the REAL numbers: practice run in this session, real check-ins still owed', () => {
    const text = fastGrowthInstruction(
      counts({ confirmedUserMemories: 3, practiceThisSession: 2, realCheckinsRemaining: 4 }),
    );
    expect(text).toContain('2 have been recorded in it so far');
    expect(text).toContain('2 recorded before this turn');
    expect(text).toContain('still needed before your stage can be read at all: 4');
    // The pace is stated too — a cap the model may know, unlike anything about
    // scoring: it is how many to ask, not what an answer is worth.
    expect(text).toContain(`until you have run ${PRACTICE_MAX_PER_SITTING}`);
    // And it is told to CLOSE on those numbers rather than improvise a status.
    expect(text).toContain('CLOSING THE SITTING');
  });

  it('reads as a sentence at zero and at one, and says so when the sample is already in', () => {
    expect(fastGrowthInstruction(counts())).toContain('None have been recorded in it yet');
    expect(fastGrowthInstruction(counts({ practiceThisSession: 1 }))).toContain(
      'One has been recorded in it so far',
    );
    const measured = fastGrowthInstruction(counts({ realCheckinsRemaining: 0 }));
    expect(measured).toContain('already answered enough check-ins during real work');
    expect(measured).not.toContain('still needed before your stage');
  });

  it('asks in the user\'s own language, in a register that is not rude', () => {
    // 2026-08-04: the interview asked a Korean user something built on a crude
    // idiom. A session that is nothing but questions is judged entirely on how
    // they read, so the register is part of the instruction — in BOTH shapes,
    // because part 2 asks questions too. The persona seed carries the same rule
    // for every other turn. It also governs the closing sentence, which the model
    // writes from the numbers above.
    for (const text of [sparse, rich]) {
      expect(text).toContain('Ask in the user\'s own language');
      expect(text).toContain('해요체/합니다체');
      expect(text).toContain('never a crude or slangy idiom');
      expect(text).toContain('in their own language');
    }
  });

  it('never tells the model what a practice answer is WORTH', () => {
    // The line M12b-5 moved, and the line it did not. The model may now be told
    // WHICH activity can move a stage (without that, it ran none) and how many to
    // ask in a sitting. It still may not learn the ledger's exchange rate: the
    // discount, the daily cap, or the windows. An agent that knew them would
    // optimize them.
    for (const text of [sparse, rich]) {
      const words = text.toLowerCase();
      for (const leak of ['drill', 'weight', 'discount', 'half', 'daily cap', 'window']) {
        expect(words).not.toContain(leak);
      }
    }
  });
});

/**
 * A SOURCE ASSERTION, for the one property no unit test in this tree can see.
 *
 * The stage-contract branch in the engine's gate must return BEFORE
 * `observeForGrowth` runs. If it ever falls through to the normal deny path, the
 * refusal is filed as a `tripwire` — the trust meter's hard block on butterfly —
 * and an agent that dutifully obeyed its own contract would thereby make the
 * stage it needs unreachable. The spike proves the behaviour end to end; this
 * catches the regression at the point someone would introduce it.
 */
describe('the stage refusal writes no ledger row', () => {
  it('the engine returns from the contract branch without observing', () => {
    const source = readFileSync(join(__dirname, '..', 'engines', 'naby.ts'), 'utf8');
    const start = source.indexOf('const refusal = stageRefusalReason({');
    expect(start).toBeGreaterThan(0);
    const branch = source.slice(start, source.indexOf('const decision = await gated.gate(call)', start));
    expect(branch).toContain("return { behavior: 'deny', reason: refusal }");
    expect(branch).not.toContain('observeForGrowth');
  });
});

/**
 * THE SECOND SOURCE ASSERTION, for the other property this tree cannot execute
 * (P3-M12b-5).
 *
 * The check-in sink must NOT be gated on a stage or on `@`-addressability. An egg
 * is exactly the agent that needs check-ins — the ledger they write is the only
 * thing that moves a stage (trust-meter §4.1) — so gating them on having a stage
 * would rebuild the M5 deadlock the `growthSubject` comment above it describes:
 * addressable enough to be trusted, trusted only by being addressed. The spike
 * (`spike:autonomy` (j3)) proves the row lands end to end; this catches the
 * regression at the line someone would write it on.
 */
describe('the check-in sink is not gated on trust', () => {
  it('its condition reads the subject and the session flag, never a stage', () => {
    const source = readFileSync(join(__dirname, '..', 'engines', 'naby.ts'), 'utf8');
    const start = source.indexOf('const checkinSink =');
    expect(start).toBeGreaterThan(0);
    const condition = source.slice(start, source.indexOf('makeCheckinSink({', start));
    expect(condition).toContain('canCheckIn(growthSubject)');
    expect(condition).toContain('!sessionNoLearn');
    for (const forbidden of ['Stage', 'stage', 'addressable', 'canBeAddressed', 'routedGrowth']) {
      expect(condition).not.toContain(forbidden);
    }
  });
});
