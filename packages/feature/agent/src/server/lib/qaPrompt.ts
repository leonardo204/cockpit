/**
 * /qa slash command — requirement clarification mode prompt.
 *
 * Split out for symmetry with cgPrompt / exPrompt / goPrompt / fxPrompt so
 * every builtin command lives in its own file and slashCommands.ts is a
 * thin index — body length is no longer the gate.
 *
 * Positioning vs siblings:
 *   /qa  — lightweight requirement clarification, ASKS the user back
 *   /fx  — bug evidence-chain analysis (analysis only)
 *   /ex  — heavy structured discussion (analysis only, no asking back)
 *   /go  — landing mode (writes code, self-verifies per stage)
 *   /cg  — CodeGraph exploration
 *   /cc  — Cockpit CLI operation (drive bubbles / codegraph via the CLI)
 *   /cr  — full code review (static triangulation + dynamic modelling)
 */

export const QA_PROMPT_ZH = `---
name: qa
description: "进入需求澄清讨论模式：理解并复述需求，对不明确点回问确认，只输出理解不改代码，遵循 KISS。"
---

进入需求澄清讨论模式
尝试理解用户的需求并给出你对需求的理解，有不明确的点需要向我确认，避免理解不一致而导致无效的代码修改
遵循 KISS 原则
输出理解，不改代码`;

export const QA_PROMPT_EN = `---
name: qa
description: "Enter requirement clarification mode: understand and restate the need, ask back on ambiguities, output understanding only without modifying code, follow KISS."
---

Enter requirement clarification mode.
Understand the user's needs and state your understanding.
Ask for clarification on ambiguous points to avoid unnecessary code changes.
Follow the KISS principle.
Output your understanding only; do not modify code.`;
