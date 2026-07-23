/**
 * /new-branch slash command — create a clean branch off the latest origin/main.
 *
 * Split out per the one-file-per-command convention (see qaPrompt / goPrompt).
 * Unlike the analysis-only commands (/qa, /fx, /ex), this one ACTUALLY runs git
 * (fetch → checkout -b → rev-list verify), closer in spirit to /go.
 *
 * EN is a faithful translation of the KO body. Label primes the trailing text
 * as an intent / requirement rather than a neutral "question".
 */

export const NEW_BRANCH_LABEL_KO = '요구사항: ';
export const NEW_BRANCH_LABEL_EN = 'Intent: ';

export const NEW_BRANCH_PROMPT_KO = `---
name: new-branch
description: "최신 origin/main 기반의 새 분기를 생성한다: 원격 fetch → origin/main에서 새 분기 분기 → 원격과 동기화되었는지 검증. 사용 상황: 사용자가 '새 분기 / 분기 생성 / new branch'라고 말하며, 새 분기가 최신 주류에서 깨끗하게 시작되기를 원할 때."
argument-hint: "[분기 이름, 비워두면 물어봄]"
---

# New Branch (최신 주류 기반 분기 생성)

최신 \`origin/main\`에서 새 분기를 분기하여 시작점이 깨끗하고 원격과 동기화되도록 합니다.

## 트리거 조건

사용자가 "새 분기 / 분기 생성 / new branch / 분기 하나 따줘"를 요청하고, 최신 주류를 기반으로 하기를 원함.

## 범위 경계 (중요)

이 skill은 **깨끗한 새 분기를 빠르게 생성하는 것만 담당**하며, "분기 직후 검증"까지입니다.

- **할 것**: fetch → \`origin/main\`에서 분기 → 동기화 검증 → 확인 출력.
- **하지 않을 것**: 탐색 / 코드 읽기, Explore / Plan agent 기동, 구현 계획 생성, 코드 작성 시작.

사용자가 트리거 시 함께 준 요구사항 설명(예: "add to slack 온보딩 흐름 개선")은 **분기 이름 추론 / 의도 기록에만 사용**하며,
이 단계에서 시작할 개발 작업이 아닙니다. 이후 요구사항 구체화와 구현은 사용자가 새 대화에서 별도로 논의하며, 이 skill의 범위가 아닙니다.

## 사전 점검

1. 분기 이름을 확인합니다(분기 이름은 항상 영어로, \`<type>/<short-desc>\` 관례를 따름. 예: \`feat/credit-guard\`, \`fix/stream-recovery\`):
   - 사용자가 이미 완성된 분기 이름을 준 경우 → 그대로 사용.
   - 사용자가 요구사항 문장을 준 경우(예: "add to slack 온보딩 흐름 개선") → **이를 근거로 자동 추론**한 영어 분기 이름(예: \`feat/slack-onboarding-flow\`)으로 바로 생성하고, 다시 묻지 않음.
   - 추론할 정보가 전혀 없는 경우 → 그때만 물어봄.
2. 현재 작업 트리가 깨끗한지 확인(\`git status\`). 커밋되지 않은 변경이 있으면, 먼저 멈춰서 사용자에게 처리 방법을 묻고, 강제로 전환하지 마세요.

## 실행 단계

\`\`\`bash
# 1. 최신 원격 주류를 가져온다
git fetch origin main

# 2. 최신 origin/main 기반으로 새 분기를 생성하고 전환한다
git checkout -b <branch-name> origin/main

# 3. 검증: 앞선 커밋 0, 뒤처진 커밋 0 이어야 함
git rev-list --left-right --count origin/main...HEAD
\`\`\`

\`git checkout -b <name> origin/main\` 한 단계로 새 분기 시작점 = 최신 원격 주류가 보장되므로, 로컬 main을 먼저 갱신할 필요가 없습니다.

## 검증 기준

- \`git rev-list --left-right --count origin/main...HEAD\`가 \`0	0\`을 출력(앞선 커밋 0, 뒤처진 커밋 0).
- \`git status\`가 새 분기 위에 있고 작업 트리가 깨끗함을 표시.

확인 출력: 분기 이름, 현재 HEAD 커밋, origin/main과의 동기화 상태.

## 언제 멈춰서 물을 것인가

- 완성된 분기 이름도, 추론 가능한 요구사항 설명도 없는 경우 → 물어봄.
- 작업 트리에 커밋되지 않은 변경이 있는 경우 → 처리 방법(stash / 커밋 / 폐기)을 묻고, 함부로 폐기하지 마세요.
- 동일한 이름의 분기가 이미 존재하는 경우 → 덮어쓸지 이름을 바꿀지 물어봄.

## 핵심 원칙

- **시작점은 항상 최신**: 항상 \`origin/main\` 기반으로, 오래되었을 수 있는 로컬 main을 기반으로 하지 않음.
- **변경을 잃지 않기**: 사용자의 작업을 잃을 수 있는 모든 작업 전에 먼저 확인.
- **분기 직후 검증**: rev-list로 실제 동기화를 확인하고, 가정에 의존하지 않음.`;

export const NEW_BRANCH_PROMPT_EN = `---
name: new-branch
description: "Create a new branch off the latest origin/main: fetch remote → branch from origin/main → verify it is in sync with the remote. Use when the user says 'new branch / create a branch', wanting the new branch to start cleanly from the latest mainline."
argument-hint: "[branch name; ask if omitted]"
---

# New Branch (create a branch off the latest mainline)

Branch off the latest \`origin/main\` so the starting point is clean and in sync with the remote.

## Trigger

The user asks to "create a new branch / new branch / cut a branch" and wants it based on the latest mainline.

## Scope (important)

This skill is **only responsible for quickly creating a clean new branch**, up to "verify right after cutting".

- **Do**: fetch → branch from \`origin/main\` → verify sync → output confirmation.
- **Do NOT**: explore / read code, spawn Explore / Plan agents, produce an implementation plan, or start writing code.

Any requirement description the user includes at trigger time (e.g. "improve the add-to-slack onboarding flow") is **only used to derive the branch name / record intent**, not a dev task to start here. Follow-up requirement refinement and implementation are discussed by the user in a new conversation and are out of scope for this skill.

## Pre-checks

1. Confirm the branch name (always in English, following the \`<type>/<short-desc>\` convention, e.g. \`feat/credit-guard\`, \`fix/stream-recovery\`):
   - User already gave a ready branch name → use it directly.
   - User gave a requirement sentence (e.g. "improve the add-to-slack onboarding flow") → **derive** an English branch name from it (e.g. \`feat/slack-onboarding-flow\`) and create it directly, no need to ask.
   - No derivable information at all → only then ask.
2. Confirm the working tree is clean (\`git status\`). If there are uncommitted changes, stop and ask the user how to handle them; do not force-switch.

## Steps

\`\`\`bash
# 1. Fetch the latest remote mainline
git fetch origin main

# 2. Create and switch to the new branch off the latest origin/main
git checkout -b <branch-name> origin/main

# 3. Verify: should be 0 ahead, 0 behind
git rev-list --left-right --count origin/main...HEAD
\`\`\`

\`git checkout -b <name> origin/main\` in one step guarantees the new branch's start = the latest remote mainline; no need to update local main first.

## Verification

- \`git rev-list --left-right --count origin/main...HEAD\` outputs \`0	0\` (0 ahead, 0 behind).
- \`git status\` shows you are on the new branch with a clean working tree.

Output confirmation: branch name, current HEAD commit, and sync status against origin/main.

## When to stop and ask

- No ready branch name and no derivable requirement description → ask.
- Uncommitted changes in the working tree → ask how to handle (stash / commit / discard); never discard on your own.
- A branch with the same name already exists → ask whether to overwrite or rename.

## Key principles

- **Start from the latest**: always base on \`origin/main\`, never on a possibly stale local main.
- **Never lose changes**: confirm before any operation that could lose the user's work.
- **Verify right after cutting**: use rev-list to confirm actual sync; never assume.`;
