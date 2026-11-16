// packages/feature/agent/src/server/lib/reviewLoopRun.ts
//
// `naby_review_loop` IN THE SHELL — the part that needs an engine.
//
// The loop, its prompts, its parsers and its stop rules are pure and live in the
// runtime (review-loop.ts, review-loop-run.ts). This module only:
//
//   * runs each reviewer and fixer as a NESTED TURN (`runNestedTurn`, the same
//     path `naby_delegate` uses), behind a role gate that only NARROWS the parent
//     turn's gate: a reviewer may read, a fixer may edit its one file;
//   * runs the whole loop in the BACKGROUND — the tool returns at once, because a
//     loop over several documents is tens of minutes and a tool call that long
//     holds the turn hostage;
//   * writes the report to `<naby home>/review-loops/<id>.md` (and the ledger as
//     JSON beside it) and hands it back as a REPORT TURN in the same session,
//     the way a finished background job is reported (backgroundJobReport.ts).
//
// ITS OWN ABORT, NOT THE TURN'S. The turn that started the loop ends seconds
// later; tying the nested runs to its signal would cancel them all. Each loop
// has its own controller and a ceiling (`REVIEW_LOOP_MAX_MS`).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath, isAbsolute } from 'node:path';
import {
  REVIEW_LOOP_TOOL_NAME,
  REVIEW_LOOP_RULE,
  reviewLoopSchema,
  validateReviewLoopInput,
  reviewRoleRefusal,
  runReviewLoop,
  renderReviewReport,
  nabyHomeDir,
  type Executor,
  type Gate,
  type ReviewRole,
  type ToolCall,
  type ToolSchema,
  type ReviewLoopResult,
} from '../../../../../../../dist/naby-runtime.mjs';
import { runNestedTurn, type NestedRunDeps } from './delegation';
import { reserveRun, releaseRun } from '../sessionRunHub';
import { JOB_REPORT_SOURCE } from './backgroundJobReport';

/** A loop that runs longer than this is stopped and reports what it has. */
export const REVIEW_LOOP_MAX_MS = 3 * 60 * 60 * 1000;

export const REVIEW_REPORT_PREFIX = '[system] The review loop ';

/** Loops running in this process, so a second call for the same session is refused
 *  rather than doubling the work. */
const running = new Map<string, { id: string; controller: AbortController; startedAt: number }>();

export function runningReviewLoop(sessionId: string): { id: string; startedAt: number } | undefined {
  const r = running.get(sessionId);
  return r ? { id: r.id, startedAt: r.startedAt } : undefined;
}

export type ReviewLoopToolDeps = {
  sessionId: string;
  cwd: string;
  /** False on a read-only turn (plan mode, changes off): the loop only reviews. */
  canMutate: boolean;
  /** Everything a nested run needs except gate, tools and signal, which this
   *  module sets per role. A GETTER, read when the tool is called: the turn's
   *  model is settled by the router after the toolset is built. */
  nested: () => Omit<NestedRunDeps, 'gate' | 'signal' | 'toolSchemas' | 'executors' | 'onSession' | 'onEvent'>;
  /** The parent turn's gate. The role gate runs first and can only refuse more. */
  gate: Gate;
  /** Tools a nested run may be offered (the workspace tools on engines without
   *  built-ins; empty on dev-claude, whose SDK brings Read/Edit itself). */
  toolSchemas: readonly ToolSchema[];
  executors: Readonly<Record<string, Executor>>;
  /** Start the report turn. Injected so tests need no orchestrator. */
  dispatchReport?: (input: { sessionId: string; prompt: string; cwd: string }) => Promise<{ ok: boolean; error?: string; status?: number }>;
};

export function buildReviewLoopReportPrompt(id: string, path: string, result: ReviewLoopResult): string {
  const r = result.report;
  return [
    `${REVIEW_REPORT_PREFIX}${id} you started has ended (${result.aborted ? 'stopped' : r.reason}).`,
    '',
    `  fixed: ${r.fixed} · decisions for the user: ${r.decisions.length} · still open: ${r.remaining.length} · deferred: ${r.deferred.length}${result.failures.length ? ` · failed steps: ${result.failures.length}` : ''}`,
    `  report: ${path}`,
    '',
    'Read the report file before you say anything about it. Then tell the user, briefly: what was fixed',
    '(including any choice or open question the fixers noted),',
    'the DECISIONS they need to make (these came back after a fix — present each with its options, do not',
    'fix them yourself), and what is still open. Do not start another review or fix round unless they ask.',
    'The user did not send this message; you are reporting back on work you started.',
  ].join('\n');
}

async function defaultDispatch(input: { sessionId: string; prompt: string; cwd: string }) {
  const [{ dispatchChat }, { nabySpec }] = await Promise.all([import('../engines/orchestrator'), import('../engines/naby')]);
  const outcome = await dispatchChat(nabySpec, { source: JOB_REPORT_SOURCE, prompt: input.prompt, sessionId: input.sessionId, cwd: input.cwd, engine: 'naby' });
  return outcome.ok ? { ok: true } : { ok: false, error: outcome.error, status: outcome.status };
}

/** The tool for this turn. */
export function makeReviewLoopTool(deps: ReviewLoopToolDeps): { schema: ToolSchema; executor: Executor } {
  const executor: Executor = async (raw) => {
    const { input, problems } = validateReviewLoopInput(raw);
    if (!input) return { content: `Cannot start the review loop: ${problems.join('; ')}.`, isError: true };
    const already = running.get(deps.sessionId);
    if (already) {
      return { content: `Review loop ${already.id} is already running in this conversation; wait for its report.`, isError: true };
    }
    const effective = deps.canMutate ? input : { ...input, maxFixRounds: 0 };
    const id = `rl-${Date.now().toString(36)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REVIEW_LOOP_MAX_MS);
    timer.unref?.();
    running.set(deps.sessionId, { id, controller, startedAt: Date.now() });
    const nestedBase = deps.nested();
    void runInBackground(deps, nestedBase, id, effective, controller).finally(() => {
      clearTimeout(timer);
      running.delete(deps.sessionId);
    });
    const files = input.groups.reduce((n, g) => n + g.files.length, 0);
    return {
      content:
        `Started review loop ${id}: ${input.groups.length} reviewer group(s), ${files} file(s), ` +
        (effective.findings?.length ? `${effective.findings.length} known finding(s) to fix first, ` : '') +
        `up to ${effective.maxFixRounds} fix round(s)${deps.canMutate ? '' : ' (this turn is read-only, so review only)'}. ` +
        'It runs in the background; you will get a report turn when it ends. Tell the user it is running, and do not review or fix these files yourself meanwhile.',
    };
  };
  return { schema: reviewLoopSchema, executor };
}

async function runInBackground(
  deps: ReviewLoopToolDeps,
  nestedBase: ReturnType<ReviewLoopToolDeps['nested']>,
  id: string,
  input: Parameters<typeof runReviewLoop>[0],
  controller: AbortController,
): Promise<void> {
  const started = Date.now();
  const abs = (p: string) => (isAbsolute(p) ? resolvePath(p) : resolvePath(deps.cwd, p));
  const log = (line: string) => console.log(`[review-loop ${id}] ${line}`);

  const nested = (role: ReviewRole, name: string, task: string) => {
    const gate: Gate = async (call: ToolCall) => {
      const refusal = reviewRoleRefusal(role, call, abs);
      if (refusal) return { behavior: 'deny', reason: refusal };
      // Attributed like a delegated subagent, so hooks and metrics treat it as one.
      return deps.gate(call.subagent ? call : { ...call, subagent: { agentId: `naby-review-${name}` } });
    };
    return runNestedTurn(
      {
        ...nestedBase,
        gate,
        signal: controller.signal,
        toolSchemas: deps.toolSchemas,
        executors: deps.executors,
        cwd: deps.cwd,
      },
      { spec: { name, systemPrompt: 'You are a focused reviewer or fixer in an automated review loop. Follow the task exactly and end with the requested JSON block.' }, task },
    );
  };

  let result: ReviewLoopResult;
  try {
    result = await runReviewLoop(input, {
      review: (g, prompt) => nested({ kind: 'reviewer' }, `reviewer-${g.name}`, prompt),
      fix: (file, prompt) => nested({ kind: 'fixer', file }, `fixer-${file.split('/').pop()}`, prompt),
      progress: log,
      signal: controller.signal,
    });
  } catch (e) {
    log(`failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  const minutes = Math.round((Date.now() - started) / 60000);
  const md = renderReviewReport(result, { id, goal: input.goal, minutes });
  let path = '';
  try {
    const dir = join(nabyHomeDir(), 'review-loops');
    mkdirSync(dir, { recursive: true });
    path = join(dir, `${id}.md`);
    writeFileSync(path, md);
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ id, sessionId: deps.sessionId, cwd: deps.cwd, input, minutes, report: result.report, failures: result.failures, findings: result.ledger.allFindings(), topics: result.ledger.allTopics() }, null, 1),
    );
  } catch (e) {
    log(`could not write the report: ${e instanceof Error ? e.message : String(e)}`);
  }
  log(`ended (${result.aborted ? 'stopped' : result.report.reason}) in ${minutes} min → ${path}`);

  // Report back the way a finished background job does: reserve the session so a
  // user message cannot slip in between, dispatch, release on failure.
  // A busy session (the user is mid-turn) answers 409; wait and retry, the same
  // policy as a background job's report.
  const prompt = buildReviewLoopReportPrompt(id, path || '(not written)', result);
  for (let attempt = 1; attempt <= REPORT_MAX_ATTEMPTS; attempt++) {
    reserveRun(deps.sessionId);
    try {
      const outcome = await (deps.dispatchReport ?? defaultDispatch)({ sessionId: deps.sessionId, prompt, cwd: deps.cwd });
      if (outcome.ok) return;
      releaseRun(deps.sessionId);
      if (outcome.status !== 409) {
        log(`report turn refused: ${outcome.error ?? outcome.status}`);
        return;
      }
    } catch (e) {
      releaseRun(deps.sessionId);
      log(`report turn threw: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    await new Promise((r) => setTimeout(r, REPORT_RETRY_MS));
  }
  log(`session stayed busy; the report is at ${path}`);
}

const REPORT_MAX_ATTEMPTS = 10;
const REPORT_RETRY_MS = 30_000;

export { REVIEW_LOOP_TOOL_NAME, REVIEW_LOOP_RULE };
