// packages/feature/agent/src/server/lib/asideUsage.ts
//
// HOW TO USE THE ASIDE BROWSER TOOLS — told to every model that is given them
// (2026-11-27).
//
// Field report: "aside CLI 를 통해 aside 참가자에게 일 시키는 결과와 aside 브라우저에서
// 자체적으로 동일한 일을 시켰을 때 작업 결과물이 차이가 난다 — 브라우저 쪽이 더 좋았다."
//
// `aside mcp` offers two ways to work. `exec` hands the task to the Aside
// browser's own agent — the one the user talks to inside Aside, with its skills
// for the user's sites and its memory of the user. `repl` has the CALLING model
// drive the page with Playwright code. Aside's own guide (`aside guide`) says
// exec is the default and repl is only for looking at the DOM or a screenshot
// directly. But the server sends no instructions, repl's description is the long
// and concrete one, and nothing in naby said which to pick: the @aside
// participant made 1,747 repl calls and 23 exec calls. So the work the user got
// from naby was a general model clicking through pages with code — while carrying
// the whole naby session as context — instead of Aside's agent starting clean.
//
// This block is added wherever the toolset holds the Aside tools: naby's own
// turn, a participant's speech, a nested run (naby_delegate, the review loop),
// and a native SDK subagent when the Aside server is connected.

import { ASIDE_SERVER_NAME } from './systemMcp';

export const ASIDE_USAGE_HEADING = '## Using the Aside browser tools';

const PREFIX = `${ASIDE_SERVER_NAME}__`;

/** Does this toolset hold any Aside tool (`aside__exec`, `aside__repl`, …)? */
export function hasAsideTools(toolNames: Iterable<string>): boolean {
  for (const n of toolNames) if (n.startsWith(PREFIX) || n.startsWith(`mcp__${PREFIX}`)) return true;
  return false;
}

export const ASIDE_USAGE_BLOCK = [
  ASIDE_USAGE_HEADING,
  "- The Aside `exec` tool hands a task to the Aside browser's own agent: the same agent the user works with inside Aside, with its skills for the user's sites and its memory of the user. Use it by default for browser work: web research, reading and checking pages, filling forms, working in signed-in services. It usually does this better than you can by driving the page yourself.",
  '- The Aside `repl` tool drives the page yourself with Playwright code. Use it only when you must inspect the DOM or a screenshot directly, or for a step exec could not do.',
  "- exec does not see this conversation. Write its prompt as a complete brief: the user's own request in their words, the URLs, what is already known, what \"done\" looks like, and what must not be changed. Ask it to report what it opened and what it saw.",
  '- For a follow-up on the same task (a fix, a second check), pass the session_id exec returned instead of starting a new session.',
  "- The Aside `memory_search` tool finds what Aside knows about the user, their projects and sites. Check it before asking the user for that context.",
].join('\n');

/** The block when the toolset holds the Aside tools; otherwise nothing. */
export function asideUsageNote(toolNames: Iterable<string>): string | undefined {
  return hasAsideTools(toolNames) ? ASIDE_USAGE_BLOCK : undefined;
}

/** `prompt` with the block appended once, when `present`. A prompt that already
 *  carries the block is left as it is. */
export function withAsideUsage(prompt: string | undefined, present: boolean): string | undefined {
  if (!present) return prompt;
  if (prompt?.includes(ASIDE_USAGE_HEADING)) return prompt;
  return prompt?.trim() ? `${prompt}\n\n${ASIDE_USAGE_BLOCK}` : ASIDE_USAGE_BLOCK;
}
