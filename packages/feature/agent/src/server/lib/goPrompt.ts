/**
 * /go slash command — landing / continuous-execution mode prompt.
 *
 * Split out of slashCommands.ts (same pattern as cgPrompt.ts / exPrompt.ts)
 * because the body is long. /qa and /fx stay inline because they are short.
 *
 * Positioning vs siblings:
 *   /qa  — lightweight requirement clarification (asks back)
 *   /fx  — bug evidence-chain analysis (analysis only)
 *   /ex  — heavy structured discussion (analysis only, no asking back)
 *   /go  — landing mode: MVP-sized stages, write code + self-verify, never
 *          pause for sign-off between stages
 *   /cg  — CodeGraph exploration
 *   /cc  — Cockpit CLI operation (drive bubbles / codegraph via the CLI)
 *   /cr  — full code review (static triangulation + dynamic modelling)
 *
 * Snapshotted verbatim from the source `go` skill — including the YAML
 * frontmatter so nothing about the skill is lost on the way in.
 */

export const GO_PROMPT_KO = `---
name: go
description: "기존 조사 결론을 바탕으로, 최소 인도 가능·검증 가능 분할 원칙에 따라 연속적으로 구현을 추진한다. 각 단계마다 코드 작성 → 자체 실행 검증 → 【인도 요약 + 검증 보고】 출력 → 자동으로 다음 단계 진입, 전부 완료 후 엔드투엔드 회고를 수행한다. 사용 상황: 조사가 수렴되었고, 사용자가 '구현 시작 / 착수 / go'라고 말하며, 중간에 끊기지 않고 자동으로 연속 추진되기를 원할 때."
argument-hint: "[조사 결론 경로 / 요약 / 비워두면 현재 세션 맥락을 이어감]"
---

# 착지 모드 (Landing Mode)

이미 수렴된 조사 결론을 MVP 단위로 자동·연속 착지시키고, 각 단계 안에서 검증 루프를 닫으며, 전부 완료된 뒤 한 번에 회고합니다.

## 트리거 조건 (모두 충족해야 함)

1. 조사/방안 논의 단계가 끝났고 결론이 수렴됨
2. 사용자가 명시적으로 "구현 시작 / 착수 / go"라고 함
3. 사용자가 각 단계마다 확인받지 않고 자동으로 연속 추진되기를 원함

하나라도 충족되지 않으면, 먼저 \`qa\` 모드로 돌아가 명확히 하세요.

## 사전 점검 (시작 전 필수)

다음 정보가 **파악되어 있는지** 확인하고, 하나라도 없으면 멈춰서 물으세요. 추측하지 마세요:

| 항목 | 출처 |
|---|---|
| 조사 결론 | 세션 맥락 / 사용자가 지정한 문서 경로 / 직접 붙여넣기 |
| 착지 범위 | 무엇을 하고, 무엇을 하지 않는가 |
| 검수 기준 | 무엇을 "엔드투엔드로 동작함"으로 볼 것인가 |
| 작업 디렉터리와 기술 스택 | 프로젝트 루트 경로, 언어, 프레임워크 |

## 실행 루프

\`\`\`
while 완료되지 않은 MVP 하위 작업이 있음:
  1. 다음 최소 폐루프 하위 작업을 선정
     - 인도 가능: 독립적으로 존재할 수 있는 산출물
     - 검증 가능: 명확한 실행/점검 방식이 있음
  2. 코드 작성(최소 변경, KISS)
  3. 자체 실행 검증: 명령 실행, 인터페이스 호출, 출력 확인 — 사용자의 승인을 기다리지 않음
  4. 【단계 N 인도 요약 + 검증 보고】 출력
  5. 멈추지 않고 다음 단계로 진입
end while

마지막으로 【전체 회고: 엔드투엔드 상호작용 검증 + 총 인도 목록】 출력
\`\`\`

## 단계별 출력 형식

\`\`\`markdown
### 단계 N: <하위 작업명>

**인도 요약**
- 목표: <이 단계에서 달성할 것>
- 변경:
  - <파일1>: <무엇을 했는가>
  - <파일2>: <무엇을 했는가>
- 상태: ✅ 완료 / ⚠️ 부분 완료 / ❌ 블로킹

**검증 보고**
- 검증 방식: <실행한 명령 / 호출한 인터페이스>
- 검증 결과: <출력 요약 / 핵심 지표>
- 잔여 문제: <없음 / 목록>
\`\`\`

## 최종 회고 형식

\`\`\`markdown
## 전체 회고

### 엔드투엔드 상호작용 검증
- 시나리오: <전체 사용자 흐름 설명>
- 단계: <1 → 2 → 3>
- 결과: <동작함 / 실패 지점>

### 총 인도 목록
| 단계 | 하위 작업 | 핵심 산출물 | 상태 |

### 알려진 잔여 사항
<없음 / 미해결 항목과 우선순위 제안 나열>
\`\`\`

## 언제 멈춰서 물을 것인가 (세 가지 경우만)

1. **블로킹 모호성**: 핵심 정보가 없어 진행 불가(미지의 API 계약, 불분명한 비즈니스 규칙)
2. **파괴적 작업**: 데이터 삭제, 원격 강제 푸시, git 히스토리 변경 등 되돌릴 수 없는 동작
3. **방안 분기**: 조사 결론이 다루지 않은 핵심 선택 결정을 발견

**다음 이유로는 멈추지 마세요**:
- "이 단계가 중요해 보이는데 확인받아야 하나" → 아니요, KISS 기본값대로 하세요
- "이렇게 할 수도 저렇게 할 수도" → 가장 단순한 구현을 골라 계속하세요
- "한 단계 끝냈으니 승인을 기다림" → 아니요, 바로 다음 단계로 진입하세요

## 핵심 원칙

- **완비보다 KISS**: 동작하는 최소 구현 > 크고 완전함
- **읽기보다 실행**: 실제로 돌려 검증 > 정적으로 코드 보기
- **멈춤보다 연속**: 자동 추진 > 잦은 질문
- **중단보다 회고**: 마지막에 한 번에 review > 중간에 끊기
`;

export const GO_PROMPT_EN = `---
name: go
description: "Based on prior research conclusions, drive landing forward in minimum-deliverable-verifiable slices. Per stage: write code → self-verify → emit [delivery summary + verification report] → auto advance to the next stage; after all stages, do one end-to-end recap. Use when: research is converged, the user says 'start landing / start implementing / go', and wants continuous progress without mid-stage interruption."
argument-hint: "[research conclusion path / brief / leave empty to reuse current session context]"
---

# Landing Mode

Take the already-converged research conclusion and land it as MVP slices continuously and automatically; each stage closes its own verification loop, with one end-to-end recap at the very end.

## Trigger conditions (all must hold)

1. The research / discussion phase has ended and the conclusion has converged
2. The user explicitly says "start landing / implement / go"
3. The user wants continuous, automatic progress without per-stage confirmation

If any condition fails, fall back to \`qa\` mode for clarification first.

## Pre-flight check (mandatory before starting)

Confirm the following are **in hand**; if any is missing, stop and ask — do not guess:

| Item | Source |
|---|---|
| Research conclusion | Session context / a path the user gives / pasted text |
| Landing scope | What's in, what's out |
| Acceptance criteria | What counts as "end-to-end runs" |
| Working directory and stack | Project root path, language, framework |

## Execution loop

\`\`\`
while there are unfinished MVP sub-tasks:
  1. Pick the next minimum closed-loop sub-task
     - Deliverable: a standalone artifact
     - Verifiable: a clear way to run / check it
  2. Write code (minimum change, KISS)
  3. Self-verify: run commands, hit endpoints, read output — do not wait for the user's nod
  4. Emit [Stage N delivery summary + verification report]
  5. No pause; proceed to the next stage
end while

Finally emit [Overall recap: end-to-end interaction verification + total delivery list]
\`\`\`

## Per-stage output format

\`\`\`markdown
### Stage N: <sub-task name>

**Delivery summary**
- Goal: <what this stage achieves>
- Changes:
  - <file1>: <what was done>
  - <file2>: <what was done>
- Status: ✅ done / ⚠️ partial / ❌ blocked

**Verification report**
- How verified: <commands run / endpoints called>
- Result: <output summary / key metrics>
- Residual issues: <none / list>
\`\`\`

## Final recap format

\`\`\`markdown
## Overall recap

### End-to-end interaction verification
- Scenario: <full user-flow description>
- Steps: <1 → 2 → 3>
- Result: <passes / failure points>

### Total delivery list
| Stage | Sub-task | Key artifact | Status |

### Known residuals
<none / list with suggested priority>
\`\`\`

## When to stop and ask (only three cases)

1. **Blocking ambiguity**: a key piece of info is missing and progress is impossible (unknown API contract, unclear business rule)
2. **Destructive operation**: deleting data, force-pushing, rewriting git history, or other irreversible actions
3. **Branching decision**: a key design choice the research did not cover

**Do NOT stop for**:
- "This step looks important, should I confirm?" → No, do the KISS default
- "Maybe this way, maybe that way" → Pick the simplest implementation and continue
- "Done with a stage, awaiting sign-off" → No, go straight to the next stage

## Key principles

- **KISS over completeness**: a minimal runnable implementation > grand-and-complete
- **Running over reading**: actually run it to verify > stare at code
- **Continuous over pausing**: auto-advance > frequent asking
- **Recap over interruption**: one final review > mid-flow breaks
`;
