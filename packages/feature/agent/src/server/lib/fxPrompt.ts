/**
 * /fx slash command — bug evidence-chain analysis mode prompt.
 *
 * Split out for symmetry with cgPrompt / exPrompt / goPrompt / qaPrompt so
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

export const FX_PROMPT_ZH = `---
name: fx
description: "进入 bug 证据链分析模式：只分析不修改代码，给出详细推理过程。"
---

进入bug证据链分析模式，只分析不修改代码，给出详细推理过程`;

export const FX_PROMPT_EN = `---
name: fx
description: "Enter bug evidence-chain analysis mode: analysis only, no code changes, with a detailed reasoning process."
---

Enter bug evidence chain analysis mode.
Analyze only; do not modify code.
Provide a detailed reasoning process.`;
