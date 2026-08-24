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
 * THE SHAPE OF AN ENTRY, which every block below follows:
 *
 *     <one lead line — what this release is ABOUT, in a sentence>
 *
 *     **New**            only the groups this release actually has. A release
 *     - …                with one fix is one **Fixed** group, not three
 *                        headings with one line each.
 *     **Improved**
 *     - …                order is always New → Improved → Fixed, so a reader
 *                        who skips to the bottom always lands on the fixes.
 *     **Fixed**
 *     - …                a detail that qualifies an item is a NESTED bullet
 *       - …              under it, not a second item competing with it.
 *
 * Groups are BOLD LINES, not `###` headings, and that is load-bearing rather
 * than taste: `###` is how the parser finds a language section
 * (releaseNotesOps.ts `LANG_HEADING`), so `### New` inside a body would be read
 * as a language called "new" and quietly swallow every line under it.
 *
 * NO TRIPLE BACKTICKS in a body, for the same class of reason — one inside a
 * bullet opens a code fence that eats the rest of the entry. Name the thing
 * instead (`a mermaid code block`).
 *
 * KOREAN IS `~해요`, NOT `~한다`. This is UI copy someone reads in a popup, not
 * a design document — the `~한다` register the project's specs mandate reads as
 * a spec talking AT the user here. It stays polite and plain, matching the
 * dictionaries' voice; the short labels around the popup live in those
 * dictionaries and keep their own.
 *
 * OLD ENTRIES CAN BE DELETED once nobody could plausibly be upgrading from that
 * far back — a user who skips versions is shown every entry in the range, so
 * the list is as long as this file lets it be.
 */
export const RELEASE_NOTES_MARKDOWN = `
## 1.26.1 — 2026-08-24

### en

The popup this is written in now actually appears.

**Improved**

- These notes are grouped into what is new, what improved and what was fixed, rather than one flat list.

**Fixed**

- After an update, this popup opens by itself on the first launch. In 1.26.0 it stayed silent for everyone: an installation with no record of a previous version was read as a brand-new one, and a brand-new user is told nothing on purpose. A fresh install is now told apart from an existing one by what was already on disk before the app started.
- The 1.26.0 entry was truncated. A code fence opened inside a bullet swallowed everything after it, so part of that release went unmentioned.

### ko

이 글이 담긴 팝업이 이제 진짜로 떠요.

**나아진 것**

- 안내를 새로 생긴 것 / 나아진 것 / 고친 것으로 묶어서 보여줘요. 예전처럼 한 덩어리로 늘어놓지 않아요.

**고친 것**

- 업데이트한 뒤 처음 켤 때 이 팝업이 저절로 열려요. 1.26.0에서는 아무에게도 뜨지 않았어요. 이전 버전 기록이 없는 설치를 새로 깐 것으로 읽었는데, 새로 까신 분께는 일부러 아무것도 알리지 않거든요. 이제는 앱이 켜지기 전에 디스크에 무엇이 있었는지를 보고 처음 설치인지 아닌지 가려내요.
- 1.26.0 안내가 중간에 잘려 있었어요. 목록 안에서 코드 블록이 열리는 바람에 뒤 내용을 통째로 삼켜서, 그 릴리즈 내용 일부가 안 보였어요.

## 1.26.0 — 2026-08-21

### en

Diagrams render, and the app tells you what changed.

**New**

- A \`mermaid\` code block draws as a diagram in the markdown viewer. Flowcharts, sequence diagrams and the rest, in the app's own font so Korean labels read properly.
- This popup. After an update, naby shows what changed on the first launch.
  - Reopen it any time from **Settings → Update**.

**Improved**

- A document tab is marked apart from a chat tab in the strip, because closing one deletes a conversation and closing the other only puts a file away.

### ko

다이어그램이 그려지고, 무엇이 바뀌었는지 앱이 알려줘요.

**새로 생긴 것**

- 마크다운 뷰어에서 \`mermaid\` 코드 블록이 다이어그램으로 그려져요. 순서도든 시퀀스 다이어그램이든 앱 글꼴로 그리니까 한글 라벨도 제대로 보여요.
- 이 팝업이요. 업데이트한 뒤 처음 켤 때 무엇이 바뀌었는지 알려줘요.
  - **설정 → 업데이트**에서 언제든 다시 열 수 있어요.

**나아진 것**

- 탭 목록에서 문서 탭이 대화 탭과 구분돼요. 대화 탭을 닫으면 대화가 지워지지만, 문서 탭을 닫아도 파일은 그대로 남거든요.

## 1.25.0 — 2026-08-21

### en

Telegram stays awake with you, and the pile of notifications is gone.

**Improved**

- Telegram keeps answering while your screen is locked or the screensaver is up. It stops only when the machine actually sleeps or powers off.
- Coming back to your desk after several runs have finished shows **one** notification carrying a count, instead of a stack of identical banners.

**Fixed**

- A Telegram poll that hangs no longer takes the whole channel down silently with it.

### ko

자리를 비운 사이에도 텔레그램은 깨어 있고, 알림은 쌓이지 않아요.

**나아진 것**

- 화면이 잠기거나 화면 보호기가 떠 있어도 텔레그램이 계속 답해요. 기기가 진짜로 잠자기에 들어가거나 꺼질 때만 멈춰요.
- 자리를 비운 사이에 여러 대화가 끝나도 알림은 **하나만** 떠요. 같은 배너가 쌓이는 대신 개수를 세어서 보여줘요.

**고친 것**

- 텔레그램 폴링 하나가 멈춰도 채널 전체가 조용히 죽지 않아요.

## 1.24.1 — 2026-08-20

### en

One line, to finish what 1.24.0 started.

**Fixed**

- The window really does reopen at its size now. 1.24.0 saved and resolved the size correctly and then opened at the primary display's size, so anyone whose window was larger than their laptop screen saw no memory of it at all.

### ko

1.24.0이 다 하지 못한 일을 마무리한 짧은 업데이트예요.

**고친 것**

- 창이 정말로 원래 크기로 다시 열려요. 1.24.0은 크기를 제대로 저장하고도 주 디스플레이 크기로 열어서, 노트북 화면보다 큰 창을 쓰던 분에게는 아무것도 기억하지 못하는 것처럼 보였어요.

## 1.24.0 — 2026-08-20

### en

Windows that remember, and documents that stay open.

**New**

- The app reopens at the size and place you left it, including maximized and full screen.
  - A window restored onto a display that is no longer connected falls back to a normal first-launch window, rather than opening somewhere you cannot reach.
- A markdown document can be attached as a tab instead of a modal, so it stays open beside the conversation you opened it to help with.

**Improved**

- The quick-question popup can be resized, and its composer now sizes to the popup instead of to the whole window.

### ko

창은 크기를 기억하고, 문서는 열어 둔 채로 남아요.

**새로 생긴 것**

- 앱이 마지막으로 두었던 크기와 위치로 다시 열려요. 최대화와 전체 화면도 기억해요.
  - 지금은 연결되어 있지 않은 디스플레이에 있던 창은, 손이 닿지 않는 곳에 열리는 대신 첫 실행과 똑같은 창으로 돌아와요.
- 마크다운 문서를 모달 대신 탭으로 붙일 수 있어요. 문서를 열어 둔 채로 보던 대화를 이어가면 돼요.

**나아진 것**

- 빠른 질문 팝업의 크기를 조절할 수 있어요. 입력창도 전체 창이 아니라 팝업 크기에 맞춰져요.

## 1.23.0 — 2026-08-20

### en

Ask without derailing the session, and see the pictures.

**New**

- Selecting text in a reply opens a throwaway popup conversation, instead of injecting the question into the transcript you were reading.
  - The popup can be dragged out of the way, or promoted into a real tab if the side question turns out to matter.

**Improved**

- Telegram names the project on every message, and reports tool calls while it works.
- The file browser reflects changes made outside it.
- Each finished turn says how long it took and when it ended.

**Fixed**

- The markdown viewer shows local images. In 1.22 it could not show a single one.

### ko

보던 대화를 흐트러뜨리지 않고 묻고, 그림도 봐요.

**새로 생긴 것**

- 답변에서 텍스트를 골라 물으면, 보던 대화 기록에 질문이 끼어드는 대신 일회용 팝업 대화가 열려요.
  - 팝업은 옆으로 끌어 둘 수 있고, 이야기가 길어지면 정식 탭으로 올릴 수도 있어요.

**나아진 것**

- 텔레그램이 모든 메시지에 프로젝트 이름을 붙이고, 일하는 동안 도구 호출을 알려줘요.
- 파일 탐색기가 앱 밖에서 생긴 변경을 반영해요.
- 턴이 끝날 때마다 얼마나 걸렸고 언제 끝났는지 알려줘요.

**고친 것**

- 마크다운 뷰어가 로컬 이미지를 보여줘요. 1.22에서는 한 장도 뜨지 않았어요.

## 1.22.0 — 2026-08-20

### en

Open that survives Windows, and Open With.

**New**

- **Open With…** joins the right-click menu on macOS and Windows, for files whose default association is wrong.

**Fixed**

- The file browser's **Open** and **Reveal** no longer depend on the Electron bridge — the local server launches them where the bridge is dark, which is what restored these items on Windows.
  - The Reveal label now names the file manager you actually have.

### ko

Windows에서도 살아남는 열기, 그리고 연결 프로그램.

**새로 생긴 것**

- **연결 프로그램으로 열기…**가 macOS와 Windows의 오른쪽 클릭 메뉴에 들어왔어요. 기본 연결 프로그램이 잘못 잡힌 파일에 쓰면 돼요.

**고친 것**

- 파일 탐색기의 **열기**와 **위치 보기**가 더 이상 Electron 브리지에 기대지 않아요. 브리지가 없는 곳에서는 로컬 서버가 대신 실행해요. Windows에서 이 항목들이 다시 살아난 이유예요.
  - 위치 보기 항목은 지금 쓰는 파일 관리자의 이름을 그대로 말해 줘요.
`;
