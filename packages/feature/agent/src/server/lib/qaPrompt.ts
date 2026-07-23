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

export const QA_PROMPT_KO = `---
name: qa
description: "요구사항 명확화 논의 모드로 진입: 요구사항을 이해하고 재진술하며, 모호한 점은 되물어 확인하고, 코드를 수정하지 않고 이해한 내용만 출력하며, KISS를 따른다."
---

요구사항 명확화 모드로 진입합니다.
사용자의 요구사항을 이해하고 이해한 내용을 진술하세요.
불필요한 코드 변경을 피하기 위해 모호한 점은 되물어 확인하세요.
KISS 원칙을 따르세요.
이해한 내용만 출력하고, 코드는 수정하지 마세요.`;

export const QA_PROMPT_EN = `---
name: qa
description: "Enter requirement clarification mode: understand and restate the need, ask back on ambiguities, output understanding only without modifying code, follow KISS."
---

Enter requirement clarification mode.
Understand the user's needs and state your understanding.
Ask for clarification on ambiguous points to avoid unnecessary code changes.
Follow the KISS principle.
Output your understanding only; do not modify code.`;
