/**
 * /ex slash command — structured discussion / analysis mode prompt.
 *
 * Split out of slashCommands.ts (same pattern as cgPrompt.ts) because the body
 * is long enough to drown the registry. /qa and /fx stay inline because they
 * are short; /ex is a full methodology skeleton.
 *
 * Positioning vs siblings:
 *   /qa  — lightweight requirement clarification, ASKS the user back
 *   /fx  — bug evidence-chain analysis (analysis only)
 *   /ex  — heavy structured discussion (analysis only, no asking back)
 *   /go  — landing mode (writes code, self-verifies per stage)
 *   /cg  — CodeGraph exploration
 *   /cc  — Cockpit CLI operation (drive bubbles / codegraph via the CLI)
 *   /cr  — full code review (static triangulation + dynamic modelling)
 *
 * Snapshotted verbatim from the source `ex` skill — including the YAML
 * frontmatter so nothing about the skill is lost on the way in.
 */

export const EX_PROMPT_KO = `---
name: ex
description: "구조화된 논의 skill: '문제 연구 + 가설-검증 루프 + 발산-수렴-발산-반복검증-요약 + What/Why/How + 비교 매트릭스' 방법론으로 복잡한 문제를 분석한다. 사용자가 \`/ex\`로 명시적으로 트리거한다. 분석만 하고 코드는 수정하지 않는다."
---

# ex — 구조화된 논의 skill

고정된 사고 골격으로 복잡한 문제를 분석합니다. **분석만 출력하고, 코드는 수정하지 않습니다.**

## 진입: 복잡도 판단

질문이 들어오면 **먼저 복잡도를 판단**하세요:

- **단순한 문제** → 바로 간단히 답하고, **방법론을 적용하지 않습니다**(KISS)
- **복잡한 문제** → 아래 6단계 골격을 완주합니다

다음 중 하나라도 해당하면 복잡한 것으로 간주:
- 여러 후보 방안을 놓고 트레이드오프가 필요함
- 검증이 필요한 여러 가설이 존재함
- 여러 모듈/시스템/계층에 걸쳐 있음
- 사용자가 명시적으로 심층 논의를 요청함

## 방법론 골격 (복잡한 문제 전용)

순서대로, **중간에 멈춰 사용자에게 묻지 말고 한 번에** 완주하세요:

\`\`\`
1. 문제 연구    What / Why / How 세 관점으로 문제 자체를 명확히 연구한다
2. 발산          가능한 가설, 방안, 관점을 열거한다
3. 수렴          Top 1-3을 추린다
4. 재발산        선정된 것을 심층 전개한다(세부, 리스크, 경계 조건)
5. 반복 검증     코드 검색 / 웹 검색 / Bash 실험으로 핵심 가설을 검증한다
6. 요약          결론을 낸다; 여러 방안/가설이 나란히 있으면 비교 매트릭스를 쓴다
\`\`\`

### What / Why / How 관점 (전 과정 관통)

- **What**: 문제/방안이 무엇이며, 경계는 어디인가
- **Why**: 왜 이 문제가 존재하는가, 왜 이 방안을 고르는가
- **How**: 어떻게 구현/실현/검증하는가

## 실행 규칙

### 한 번에 완주, 사용자를 중단시키지 않기

- 전 과정에서 **AskUserQuestion을 호출하지 않습니다**
- 정보가 부족하면 → **"⚠️ 보완 필요: xxx"**로 명확히 표시하고, 사용자가 이후에 추가로 보완하도록 합니다
- 정보가 불완전하다고 흐름을 중단하지 말고, 근거가 허용하는 데까지 밀어붙이세요

### 검증 수단

허용되는 검증 방식:

| 수단 | 도구 | 사용 상황 |
|---|---|---|
| 코드 검색 | Grep / Read / Glob | 저장소에서 가설을 뒷받침할 증거를 찾음 |
| 웹 검색 | WebSearch / WebFetch | 공식 문서, 외부 자료를 조회 |
| Bash 실험 | Bash | 작은 명령, 테스트 스크립트, curl 실행 |

**금지**: AskUserQuestion으로 사용자에게 물어 검증하는 것.

## 출력 규칙

- **고정된 출력 구조를 강제하지 않고**, 문제 특성에 맞게 유연하게 구성합니다
- **비교 매트릭스는 필수가 아니며**, "여러 방안/가설을 나란히 비교해야 할 때"만 출력합니다
- 단순한 문제는 짧게 답하고, 틀을 위한 틀을 씌우지 마세요

## 하지 않는 것

- ❌ 코드를 수정하지 않음 (이것은 논의 skill이지 구현 skill이 아님)
- ❌ 중간에 사용자에게 묻지 않음 (한 번에 완주)
- ❌ 모든 문제에 비교 매트릭스를 강제하지 않음
- ❌ \`/qa\`, \`/fx\`와 경쟁하지 않음 — 셋은 나란한 형제로, 사용자가 명시적으로 선택해 트리거함
`;

export const EX_PROMPT_EN = `---
name: ex
description: "Structured discussion skill: analyze complex problems with the methodology of 'problem study + hypothesis-verify loop + diverge-converge-diverge-iterate-verify-summarize + What/Why/How + comparison matrix'. Explicitly triggered by the user via \`/ex\`. Analysis only; do not modify code."
---

# ex — structured discussion skill

Analyze complex problems with a fixed thinking skeleton. **Output analysis only; do not modify code.**

## Entry: complexity check

When the question arrives, **first judge complexity**:

- **Simple problem** → answer directly, **do not apply the methodology** (KISS)
- **Complex problem** → run the full 6-step skeleton below

Treat as complex if any of these holds:
- Multiple candidate solutions need trade-off
- Multiple hypotheses need verification
- Spans multiple modules / systems / layers
- The user explicitly asks for deep discussion

## Methodology skeleton (complex problems only)

Run in order, **in one pass, without stopping to ask the user**:

\`\`\`
1. Problem study   Clarify the problem itself through What / Why / How
2. Diverge         Enumerate candidate hypotheses, solutions, perspectives
3. Converge        Pick the top 1-3
4. Diverge again   Deep-dive into the chosen ones (details, risks, edge cases)
5. Iterate-verify  Verify key hypotheses via code search / web search / bash experiments
6. Summarize       Conclude; use a comparison matrix when multiple options sit side by side
\`\`\`

### What / Why / How facets (cross-cutting)

- **What**: what is the problem / solution, what is the boundary
- **Why**: why does this problem exist, why pick this solution
- **How**: how to implement / land / verify it

## Execution rules

### Run once, never interrupt the user

- **Never call AskUserQuestion**
- When information is missing → explicitly mark **"⚠️ Pending: xxx"** and let the user follow up later
- Do not stop just because info is incomplete; push as far as the evidence allows

### Verification means

Allowed verification tools:

| Means | Tools | Use case |
|---|---|---|
| Code search | Grep / Read / Glob | Find in-repo evidence for hypotheses |
| Web search | WebSearch / WebFetch | Look up official docs and external material |
| Bash experiments | Bash | Run small commands, test scripts, curl |

**Forbidden**: verifying by asking the user via AskUserQuestion.

## Output rules

- **No mandatory output template** — organize by what the problem needs
- **Comparison matrix is optional** — use it only when multiple options / hypotheses must sit side by side
- Simple questions get short answers; do not over-frame for the sake of framing

## What this skill does NOT do

- ❌ Do not modify code (this is a discussion skill, not an implementation skill)
- ❌ Do not interrupt the user mid-flow (one-shot)
- ❌ Do not force a comparison matrix on every question
- ❌ Do not compete with \`/qa\` or \`/fx\` — the three are siblings, triggered explicitly by the user`;
