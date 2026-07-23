/**
 * /ap slash command — "apply" mode prompt.
 *
 * Split out for symmetry with qaPrompt / cgPrompt / exPrompt / goPrompt / fxPrompt
 * so every builtin command lives in its own file and slashCommands.ts is a thin
 * index.
 *
 * Positioning vs siblings:
 *   /qa  — lightweight requirement clarification, ASKS the user back
 *   /go  — landing mode (writes code, self-verifies per stage)
 *   /ap  — apply mode: implement <SPEC> while keeping a running apply-notes.html
 *          (in the temp dir) of out-of-spec decisions, changes, and tradeoffs
 */

export const AP_PROMPT_KO = `---
name: ap
description: "apply: <SPEC>를 구현하면서, 구현 과정 내내 apply-notes HTML 파일(임시 디렉터리에 위치)을 지속적으로 유지하여 스펙이 다루지 않은 결정, 변경, 트레이드오프를 기록한다."
argument-hint: "[SPEC 경로 / 비워두면 = 이번 대화에서 합의된 spec]"
---

<SPEC>를 구현하세요. 구현하는 동안, 스펙에는 없지만 어쩔 수 없이 내린 결정,
어쩔 수 없이 바꾼 것, 어쩔 수 없이 감수한 트레이드오프, 그리고 내가 알아야 할
그 밖의 모든 것을 기록하는 apply-notes.html 파일을 지속적으로 유지하세요.
이것은 작업 로그가 아닙니다 — 테스트 통과나 빌드 green 전환 같은 일상적인
진행 상황은 여기에 들어가지 않습니다.

파일은 \`\${TMPDIR%/}/apply-notes-<feature-name>.html\`에 두고, 절대 저장소
안에는 두지 마세요. 요구사항마다 파일 하나를 유지합니다: 어떤 라운드가 같은
작업을 이어가는 경우, 새로 만들지 말고 기존 파일에 새 round 제목을 달아 이어
쓰세요. 새로운 요구사항일 때만 새 파일을 만듭니다. 항상 Edit 도구로 갱신하고
(최초 생성 시에만 Write), 절대 shell 리다이렉션으로 쓰지 마세요.`;

export const AP_PROMPT_EN = `---
name: ap
description: "apply: implement <SPEC> while keeping a running apply-notes HTML file (in temp dir) of decisions not covered by the spec, changes, and tradeoffs."
argument-hint: "[SPEC path / empty = spec agreed in this conversation]"
---

Implement <SPEC>; and while you do, keep a running apply-notes.html file
with decisions you had to make that weren't in the spec, things you had
to change, tradeoffs you had to make, or anything else I should know.
It is not a work log — routine progress like tests passing or builds
going green doesn't belong in it.

Keep the file at \`\${TMPDIR%/}/apply-notes-<feature-name>.html\`, never
inside the repo, one file per requirement: when a round continues the
same task, append to the existing file under a new round heading rather
than starting a fresh one; only a new requirement gets a new file.
Always update it with the Edit tool (Write only when first creating it),
never through shell redirection.`;
