/**
 * THE CHANGELOG. This file is the content, and it is meant to be edited by hand
 * at release time — one new `## <version>` block at the top, two languages, a
 * few lines each. Nothing generates it and nothing else needs updating.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A STRING IN A SOURCE FILE RATHER THAN A FILE ON DISK
 *
 * Three properties were required and this is the only shape that has all three.
 *
 *   1. IT WORKS WITH NO NETWORK. Fetching release notes from GitHub means the
 *      popup is sometimes an empty box — worse than not shipping it. (The
 *      GitHub releases for this repo have empty bodies anyway; the hand-written
 *      summary lives in the version-bump commit.)
 *   2. IT CANNOT BE LOST BY PACKAGING. A markdown file read at runtime needs a
 *      path resolved inside an asar, and this project has a whole spec about
 *      getting that wrong (specs/packaging-path-resolution.md) plus a rule that
 *      such bugs are NOT reproducible on the build machine. A string in a
 *      module is compiled into the renderer bundle: there is no path to
 *      resolve, no read to fail and nothing to add to electron-builder's file
 *      list.
 *   3. IT IS BILINGUAL WITHOUT DUPLICATING THE VERSION. The app ships en and
 *      ko, so the notes must too, and the version and date should be stated
 *      once rather than in two files that drift.
 *
 * The notes are NOT in the i18n dictionaries, deliberately. Those are UI copy —
 * short labels reused across screens — and appending a growing archive of prose
 * to both of them would put the changelog on the critical path of every
 * translation edit while breaking the "same keys in both files" property the
 * moment a release documents one language first.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FORMAT, in full
 *
 *     ## <version> — <date>        one block per release, NEWEST FIRST
 *     ### en                       the body for that language, as markdown
 *     ### ko
 *
 * `parseReleaseNotes` (releaseNotesOps.ts) is the only reader. It is total: a
 * block with an unparseable version, a missing language or a stray heading is
 * dropped rather than thrown, because this file is on the app's startup path
 * and a typo in a changelog must never be able to stop the app from opening.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT TO WRITE
 *
 * For the user, not for the diff. The reader is someone who just watched the
 * app restart and wants to know what is different for THEM: what they can now
 * do, or what stopped being broken. The version-bump commit for each release
 * already says exactly that in its subject and first paragraph (`git log`
 * v1.2x.0) — that sentence is the raw material, and turning it into an entry
 * here is meant to be a copy-and-trim, not a writing exercise.
 *
 * Korean bodies use the plain `~한다` form the project's documents use. Short UI
 * labels around the popup stay in the i18n dictionaries and keep that file's
 * own voice.
 *
 * OLD ENTRIES CAN BE DELETED once nobody could plausibly be upgrading from that
 * far back — a user who skips versions is shown every entry in the range, so
 * the list is as long as this file lets it be.
 */
export const RELEASE_NOTES_MARKDOWN = `
## 1.26.0 — 2026-08-21

### en

Diagrams render, and the app now tells you what changed.

- \`\`\`mermaid blocks draw as diagrams in the markdown viewer. Flowcharts, sequence diagrams and the rest, in the app's own font so Korean labels read properly.
- This popup. After an update, naby shows what changed on first launch — and you can reopen it any time from Settings → Update.
- A document tab is marked apart from a chat tab in the strip, because closing one deletes a conversation and closing the other only puts a file away.

### ko

다이어그램이 그려지고, 무엇이 바뀌었는지 앱이 알려준다.

- 마크다운 뷰어에서 \`\`\`mermaid 블록이 다이어그램으로 그려진다. 순서도와 시퀀스 다이어그램 모두 앱 글꼴로 그려지므로 한글 라벨도 제대로 보인다.
- 이 팝업이다. 업데이트 후 처음 실행할 때 무엇이 바뀌었는지 알려주고, 설정 → 업데이트에서 언제든 다시 열 수 있다.
- 문서 탭이 대화 탭과 구분되어 표시된다. 대화 탭을 닫으면 그 대화가 삭제되지만 문서 탭을 닫으면 파일은 그대로 남기 때문이다.

## 1.25.0 — 2026-08-21

### en

Telegram stays awake with you, and the pile of notifications is gone.

- Telegram keeps answering while your screen is locked or the screensaver is up. It stops only when the machine actually sleeps or powers off.
- A Telegram poll that hangs no longer takes the whole channel down silently with it.
- Coming back to your desk after several runs have finished now shows **one** notification carrying a count, instead of a stack of identical banners.

### ko

텔레그램이 자리를 비운 사이에도 깨어 있고, 알림이 쌓이지 않는다.

- 화면이 잠기거나 화면 보호기가 떠 있어도 텔레그램이 계속 응답한다. 기기가 실제로 잠자기에 들어가거나 꺼질 때만 멈춘다.
- 텔레그램 폴링 하나가 멈춰도 채널 전체가 조용히 죽지 않는다.
- 자리를 비운 사이 여러 대화가 끝나도 알림은 **하나만** 뜬다. 같은 배너가 쌓이는 대신 개수를 세어 보여준다.

## 1.24.1 — 2026-08-20

### en

- The window really does reopen at its size now. 1.24.0 saved and resolved the size correctly and then opened at the primary display's size, so anyone whose window was larger than their laptop screen saw no memory of it at all.

### ko

- 창이 정말로 원래 크기로 다시 열린다. 1.24.0은 크기를 올바르게 저장하고도 주 디스플레이 크기로 열어서, 노트북 화면보다 큰 창을 쓰던 사람에게는 아무것도 기억하지 못하는 것처럼 보였다.

## 1.24.0 — 2026-08-20

### en

Windows that remember, and documents that stay open.

- The app reopens at the size and place you left it, including maximized and full screen. A window restored onto a display that is no longer connected falls back to a normal first-launch window rather than opening somewhere you cannot reach.
- The quick-question popup can be resized, and its composer now sizes to the popup instead of to the whole window.
- A markdown document can be attached as a tab instead of a modal, so it stays open beside the conversation you opened it to help with.

### ko

창은 크기를 기억하고, 문서는 열어 둔 채로 남는다.

- 앱이 마지막으로 두었던 크기와 위치로 다시 열린다. 최대화와 전체 화면도 기억한다. 지금은 연결되어 있지 않은 디스플레이에 있던 창은 손이 닿지 않는 곳에 열리는 대신 첫 실행과 똑같은 창으로 돌아온다.
- 빠른 질문 팝업의 크기를 조절할 수 있다. 입력창도 전체 창이 아니라 팝업 크기에 맞춘다.
- 마크다운 문서를 모달 대신 탭으로 붙일 수 있다. 문서를 열어 둔 채로 원래 보던 대화를 이어갈 수 있다.

## 1.23.0 — 2026-08-20

### en

Ask without derailing the session, and see the pictures.

- The markdown viewer shows local images. In 1.22 it could not show a single one.
- Selecting text in a reply opens a throwaway popup conversation instead of injecting the question into the transcript you were reading. The popup can be dragged out of the way, or promoted into a real tab if the side question turns out to matter.
- Telegram names the project on every message and reports tool calls while it works.
- The file browser reflects changes made outside it.
- Each finished turn says how long it took and when it ended.

### ko

보던 대화를 흐트러뜨리지 않고 묻고, 그림도 본다.

- 마크다운 뷰어가 로컬 이미지를 보여준다. 1.22에서는 한 장도 뜨지 않았다.
- 답변에서 텍스트를 선택해 질문하면, 보고 있던 대화 기록에 질문이 끼어드는 대신 일회용 팝업 대화가 열린다. 팝업은 옆으로 끌어 둘 수 있고, 이야기가 길어지면 정식 탭으로 올릴 수 있다.
- 텔레그램이 모든 메시지에 프로젝트 이름을 붙이고, 작업하는 동안 도구 호출을 알려준다.
- 파일 탐색기가 앱 밖에서 생긴 변경을 반영한다.
- 턴이 끝날 때마다 얼마나 걸렸고 언제 끝났는지 표시한다.

## 1.22.0 — 2026-08-20

### en

Open that survives Windows, and Open With.

- The file browser's **Open** and **Reveal** no longer depend on the Electron bridge — the local server launches them where the bridge is dark, which is what restored these items on Windows.
- **Open With…** joins the right-click menu on macOS and Windows, for files whose default association is wrong.
- The Reveal label names the file manager you actually have.

### ko

Windows에서도 살아남는 열기, 그리고 연결 프로그램.

- 파일 탐색기의 **열기**와 **위치 보기**가 더 이상 Electron 브리지에 의존하지 않는다. 브리지가 없는 곳에서는 로컬 서버가 대신 실행한다. Windows에서 이 항목들이 다시 동작하게 된 이유다.
- **연결 프로그램으로 열기…**가 macOS와 Windows의 오른쪽 클릭 메뉴에 들어왔다. 기본 연결 프로그램이 잘못 잡힌 파일에 쓴다.
- 위치 보기 항목이 실제로 쓰는 파일 관리자의 이름을 말한다.
`;
