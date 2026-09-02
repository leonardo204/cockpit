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
## 1.34.0 — 2026-09-02

### en

The right panel gains a git view: what changed, where your branch is, and the history as a graph.

**New**

- **A git panel, behind the branch icon at the top right.** It sits beside the file browser and the two take turns in the same space, so the conversation is never squeezed between them. It shows the files you have changed, which branch you are on and how far ahead or behind its remote it is, your branches, and the history drawn as a graph with the branch lines coloured.
- **Click a changed file, or any commit, to read the diff.** It opens in a tab next to the conversation rather than in a box on top of it — so you can look at the change and ask naby about it at the same time. There is a button on the diff that writes the question for you.
- **The panel has no buttons that change anything, on purpose.** Committing, pulling, pushing and sorting out a conflict are things you ask naby for in a sentence, and the panel writes that sentence into the message box for you to send. Half the job in buttons and half in questions would only leave you guessing which was which.

**Fixed**

- **Work you do outside the app shows up straight away.** Running \`git fetch\`, \`git push\`, \`git branch\` or \`git tag\` in a terminal — or letting naby run them — used to leave the panel showing numbers that were true a minute ago, because none of those touch the files the app was watching. They now arrive in about a fifth of a second, whoever ran them.

### ko

오른쪽 패널에 git 보기가 생겼어요. 뭐가 바뀌었는지, 지금 어느 브랜치인지, 이력이 어떻게 갈라졌는지 보여 줘요.

**새로 생긴 것**

- **오른쪽 위 브랜치 아이콘을 누르면 git 패널이 열려요.** 파일 목록과 같은 자리를 번갈아 써요. 둘이 동시에 뜨지 않으니 대화가 양쪽에 끼이지 않아요. 바꾼 파일, 지금 브랜치와 원격보다 얼마나 앞서거나 뒤처졌는지, 브랜치 목록, 그리고 갈래마다 색이 다른 커밋 그래프를 보여 줘요.
- **바뀐 파일이나 커밋을 누르면 무엇이 달라졌는지 볼 수 있어요.** 대화 위를 덮는 창이 아니라 옆 탭으로 열려요. 그래서 변경을 보면서 그 자리에서 나비에게 물어볼 수 있어요. 물어볼 말을 대신 써 주는 버튼도 있어요.
- **이 패널에는 저장소를 바꾸는 버튼이 없어요. 일부러 그렇게 했어요.** 커밋하고, 받아오고, 올리고, 충돌을 푸는 일은 나비에게 말로 시키면 돼요. 패널은 그 말을 메시지 상자에 대신 적어 주고, 보내는 건 직접 하시면 돼요. 절반은 버튼으로 절반은 말로 하면 어느 쪽인지 매번 헷갈리니까요.

**고친 것**

- **앱 밖에서 한 작업도 바로 보여요.** 터미널에서 \`git fetch\`, \`git push\`, \`git branch\`, \`git tag\`를 치거나 나비가 대신 실행하면, 예전에는 패널이 한참 전 숫자를 그대로 보여 줬어요. 그 명령들은 앱이 지켜보던 파일을 건드리지 않았거든요. 이제 누가 실행하든 0.2초쯤 뒤에 반영돼요.

## 1.33.0 — 2026-08-31

### en

A new tab is one keystroke, and carrying a conversation onward says that it is working.

**New**

- **Cmd+T opens a new tab — Ctrl+T on Windows and Linux.** The `+` button's tooltip names whichever key your own machine uses, and so do the numbered hints on the tabs: they used to say ⌘ everywhere, including on Windows.

**Fixed**

- **"Continue in a new tab" shows that it is working.** It takes a few seconds, because naby is summarising the conversation you are carrying over — and until now nothing said so. The tab grows a spinner, the menu item says what is happening, and a second click is refused rather than quietly starting a second conversation with a second summary behind it. A failure now says it failed, instead of leaving you looking at a menu that closed and did nothing.
- **The model list names the models you actually have.** The app carried two copies of the Claude Agent SDK and used the older one, so the picker still said "Sonnet 4.6" where the current one says "Sonnet 5" and "Opus 5 with 1M context". Both copies are now the same, current version.
  - The list is also refreshed the moment you install a new build. It was remembered for a day at a time, which meant an upgrade could go on showing the previous version's model names until that day ran out.

### ko

새 탭이 단축키 하나로 열리고, 대화를 이어갈 때 지금 일하는 중이라고 말해 줘요.

**새로 생긴 것**

- **Cmd+T로 새 탭을 열어요. 윈도우와 리눅스는 Ctrl+T예요.** `+` 버튼 툴팁이 이 기계에서 실제로 쓰는 키를 알려 줘요. 탭에 붙은 번호 힌트도 마찬가지예요. 예전에는 윈도우에서도 ⌘라고 적혀 있었어요.

**고친 것**

- **"새 탭에서 이어가기"가 지금 작업 중이라고 알려 줘요.** 넘겨받을 대화를 나비가 요약하느라 몇 초가 걸리는데, 그동안 아무 말이 없었어요. 이제 그 탭에 스피너가 돌고, 메뉴 항목이 무슨 일이 벌어지는지 말해 주고, 두 번째 클릭은 거절돼요. 예전에는 그 두 번째 클릭이 요약을 하나 더 만들면서 대화도 하나 더 만들었어요. 실패하면 실패했다고 말해 줘요. 메뉴만 닫히고 아무 일도 없던 예전과 달라요.
- **모델 목록이 실제로 쓸 수 있는 모델을 말해요.** 앱 안에 Claude Agent SDK가 두 벌 들어 있었고 그중 오래된 쪽을 쓰고 있었어요. 그래서 지금은 "Sonnet 5", "Opus 5 with 1M context"라고 부르는 것을 목록은 아직 "Sonnet 4.6"이라고 적고 있었어요. 이제 두 벌이 같은 최신 버전이에요.
  - 새 빌드를 설치하면 목록도 그 자리에서 갱신돼요. 예전에는 하루 단위로 기억해 둬서, 업데이트를 해도 그 하루가 지나기 전까지는 지난 버전의 모델 이름이 계속 보일 수 있었어요.

## 1.32.0 — 2026-08-27

### en

What you ask for now outranks what naby worked out on its own.

**New**

- Agree to a memory right where naby proposes it. When naby notes something down, the note itself offers to remember it — no trip to settings to find a row you just watched being written. Settings still works exactly as before.

**Improved**

- Something you told naby beats something naby inferred. Memory was ranked by where it applied, so a fact naby had worked out from a project's code could quietly overrule an instruction you gave in words — and repeating yourself would not have helped, because the repeat landed in the same lower-ranked place. Who said it now comes first.
- Agreeing to a memory is what makes it yours. Confirming a suggestion used to change only whether it was in use, not whose word it carried, so you could agree to "answer in Korean" and still lose to something naby had guessed.
- naby no longer copies how you type. It used to measure your writing — how your sentences end, how long they run — and correct its own answers toward that. But how you type an instruction and how you want to be answered are different things: someone who types "커밋 푸시 릴리즈 배포" and has asked for polite answers was being steered back toward their own shorthand. How naby speaks is something you tell it, not something it measures.
  - Which LANGUAGE it answers in is still checked. That one is read from what you just wrote, not inferred from a sample of your habits.

### ko

이제 부탁하신 것이 나비가 혼자 알아낸 것보다 우선해요.

**새로 생긴 것**

- 나비가 제안한 그 자리에서 바로 기억시킬 수 있어요. 나비가 무언가를 적어 두면 그 기록이 "기억할까요?"를 물어봐요. 방금 눈앞에서 쓰인 항목을 찾으러 설정까지 가지 않아도 돼요. 설정에서 하던 방식도 그대로예요.

**나아진 것**

- 직접 말씀하신 것이 나비의 추측을 이겨요. 기억이 "어디에 적용되나"로 줄을 서다 보니, 나비가 프로젝트 코드에서 알아낸 것이 말씀으로 주신 지시를 조용히 덮곤 했어요. 다시 말씀하셔도 같은 낮은 자리에 떨어져서 소용이 없었고요. 이제 "누가 말했나"를 먼저 봐요.
- 동의하시는 것이 곧 그 기억을 사용자 것으로 만들어요. 예전에는 제안에 동의해도 "쓰이는지"만 바뀌고 "누구 말인지"는 그대로였어요. 그래서 "한국어로 답한다"에 동의해도 나비의 추측에 지곤 했어요.
- 나비가 사용자의 문체를 따라 하지 않아요. 예전에는 사용자가 쓰는 문장의 어미와 길이를 재서 자기 답을 거기에 맞췄어요. 그런데 지시를 입력하는 방식과 답변받고 싶은 방식은 다른 얘기예요. "커밋 푸시 릴리즈 배포"처럼 쓰면서 공손한 답변을 원하신 분은 오히려 자기 축약체 쪽으로 끌려가고 있었어요. 나비가 어떻게 말할지는 사용자가 정해 주시는 것이지 나비가 재는 게 아니에요.
  - 어느 **언어**로 답할지는 계속 봐요. 그건 습관을 표본으로 추론한 게 아니라 방금 쓰신 글에서 읽는 것이니까요.

## 1.31.2 — 2026-08-26

### en

The conversation a project opens on actually appears.

**Fixed**

- **Opening a project shows the conversation, not an empty chat.** 1.31.1 fixed half of this; the half that mattered was still there. The transcript was requested once, at the moment the chat first appeared — and a tab does not know which conversation it is on yet at that moment, because the session it resumes is picked up a fraction of a second later. It now waits for the session and then loads it.
  - This is why the history used to turn up only after you started typing: sending a message was the one thing that told the chat which session it was on.

### ko

프로젝트를 열면 그 대화가 실제로 보여요.

**고친 것**

- **프로젝트를 열면 대화가 보여요. 빈 채팅이 아니라요.** 1.31.1에서 절반만 고쳐졌고, 정작 중요한 절반이 남아 있었어요. 대화 내역을 채팅이 처음 뜨는 순간에 딱 한 번 요청했는데, 그 순간에는 탭이 아직 자기가 어느 대화인지 몰라요. 이어받을 세션은 그보다 아주 조금 뒤에 정해지거든요. 이제 세션이 정해질 때까지 기다렸다가 불러와요.
  - 예전에 뭔가 입력해야 그제서야 내역이 나타난 이유가 이거예요. 메시지를 보내는 게 채팅에게 자기 세션을 알려 주는 유일한 방법이었어요.

## 1.31.1 — 2026-08-26

### en

Four things that were quietly telling you the wrong thing.

**Fixed**

- **The what's-new popup comes back.** It had gone silent for good on some machines: the app was reading Electron's version number instead of its own, writing that to disk, and then finding that no release could ever be newer than it. The number is fixed, and a watermark that could not have come from this app is no longer believed — so installations already stuck on one repair themselves.
- **A tab that opens on a conversation shows it.** After an upgrade your session was there but looked empty until you switched tabs and came back. The history was only fetched when a tab was switched TO, and the first tab of a launch is never switched to — it is already there.
- **"Rate Limited" goes away when it is over.** It marked the moment a request was turned away and then nothing ever cleared it, so it sat there in red beside a plan chip reading 16%. It now expires when the reset time passes, and a completed turn clears it immediately.
- **A busy server no longer reads as a spent plan.** When a request is retried because the server is under load, it now says so — and says outright that it is not your usage limit. Retrying was always happening; it was describing itself in English, in developer's terms.

### ko

조용히 틀린 얘기를 하고 있던 네 가지를 고쳤어요.

**고친 것**

- **변경 사항 팝업이 다시 떠요.** 어떤 컴퓨터에서는 영영 안 뜨는 상태였어요. 앱이 자기 버전 대신 Electron의 버전을 읽어 디스크에 적어 뒀는데, 그 숫자보다 큰 릴리즈가 나올 수 없어서요. 숫자를 바로잡았고, 이 앱이 남겼을 리 없는 기록은 더 이상 믿지 않아요. 이미 그 상태인 설치도 알아서 회복돼요.
- **대화를 이어받은 탭에 대화가 보여요.** 업그레이드 뒤에 세션은 있는데 비어 보이다가, 다른 탭에 갔다 오면 그제서야 보였어요. 히스토리를 "탭으로 전환할 때"만 불러왔는데, 앱을 켤 때 첫 탭은 전환되는 일이 없거든요. 이미 거기 있으니까요.
- **"Rate Limited" 표시가 끝나면 사라져요.** 요청이 거절당한 순간을 표시해 놓고 지우는 곳이 없어서, 옆에 플랜 16%가 떠 있는데도 빨갛게 남아 있었어요. 이제 리셋 시각이 지나면 사라지고, 턴이 한 번 성공하면 바로 사라져요.
- **서버가 붐비는 걸 사용량 초과로 읽지 않아요.** 서버가 붐벼서 다시 보내는 중일 때 그렇다고 말해 주고, 사용량 한도 때문이 아니라고 분명히 밝혀요. 다시 보내는 동작은 원래 하고 있었는데, 영어로 개발자 말투로 설명하고 있었어요.

## 1.31.0 — 2026-08-26

### en

The file panel works like a file manager, and it shows you what has changed.

**New**

- Changed files are coloured, and so is every folder above them — a collapsed folder still tells you something inside it moved. Modified, added, deleted, untracked and conflicted each look different, and hovering any of them says which.
  - A project with **no git repository** is not left blank: it shows what has changed since you opened it, in a colour of its own, and the tooltip says that is the baseline. There is no commit to compare against, so the app says which comparison it is making rather than letting you guess.
  - Colours keep themselves up to date. A \`git add\` or \`commit\` you run in a terminal changes nothing in your files, so nothing used to notice it — that is now watched for separately, and the colours follow.
- Rows can be selected: click one, ⌘/Ctrl-click to add another, shift-click for a range.
- Copy, cut and paste — with ⌘/Ctrl-C, X and V, or from the right-click menu. A cut moves nothing until you paste it, so you can change your mind, and the rows waiting to move are dimmed.
- Drag rows onto a folder to move them there; hold Alt/Option to copy instead. Dropping onto the empty space below the tree moves them to the top of the project.
- Alt-drag a row out of the app to hand the files to Finder or Explorer.

**Changed**

- ⌘/Ctrl-click on a row now adds it to the selection instead of putting \`@path\` in the message box. In a file tree that gesture means one thing to everybody. To reference a file in a message, drag the row into the box, or use **Copy path** in the right-click menu.

### ko

파일 패널이 탐색기처럼 동작하고, 무엇이 바뀌었는지 보여줘요.

**새로 생긴 것**

- 바뀐 파일에 색이 붙고, 그 위 폴더에도 붙어요. 접어 둔 폴더도 안에서 뭔가 움직였다는 걸 알려줘요. 수정·추가·삭제·추적 안 됨·충돌이 각각 다르게 보이고, 위에 올리면 무엇인지 알려줘요.
  - **git 저장소가 아닌 프로젝트**도 비워 두지 않아요. 프로젝트를 연 뒤에 바뀐 파일을 따로 구분되는 색으로 보여주고, 그게 기준이라고 툴팁에 적어요. 견줄 커밋이 없으니 무엇과 견주는 중인지 앱이 밝히는 거예요.
  - 색은 알아서 최신을 유지해요. 터미널에서 \`git add\`나 \`commit\`을 해도 파일 자체는 그대로라 예전에는 아무도 눈치채지 못했는데, 이제 그쪽도 따로 지켜보고 색이 따라가요.
- 행을 선택할 수 있어요. 클릭하면 하나, ⌘/Ctrl-클릭으로 추가, shift-클릭으로 범위예요.
- 복사·잘라내기·붙여넣기가 돼요. ⌘/Ctrl-C, X, V 또는 우클릭 메뉴로요. 잘라내기는 붙여넣기 전까지 아무것도 옮기지 않아서 마음을 바꿀 수 있고, 옮길 예정인 행은 흐리게 보여요.
- 행을 폴더 위로 끌면 옮겨져요. Alt/Option을 누르고 있으면 복사예요. 트리 아래 빈 곳에 놓으면 프로젝트 맨 위로 옮겨져요.
- Alt를 누른 채 앱 밖으로 끌면 Finder나 탐색기로 파일이 건네져요.

**달라진 것**

- 행을 ⌘/Ctrl-클릭하면 이제 메시지 상자에 \`@경로\`를 넣는 대신 선택에 추가돼요. 파일 트리에서 이 동작은 누구에게나 한 가지 뜻이라서요. 메시지에 파일을 언급하려면 행을 상자로 끌거나 우클릭 메뉴의 **경로 복사**를 쓰세요.

## 1.30.0 — 2026-08-25

### en

Projects open where you left off, and a file path in a message is something you can click.

**New**

- A file path naby writes out is now a link. Click it and the document opens in a tab beside the conversation, so you no longer have to select the path, copy it and leave the app to read what was just written for you. It works for paths anywhere on your machine, not only inside the open project.
  - Only documents (\`.md\`, \`.markdown\`, \`.txt\`) become links, and only a path written out on its own — a link someone typed by hand is never turned into a file link, so what a link says is always where it goes.
- naby writes paths out in full now, instead of shortening your home folder to \`~\`, so the path it hands you is the one you can click.

**Changed**

- Opening a project puts you back in the conversation you were last in. It used to start an empty chat every time, which meant a project full of work greeted you with a blank page and a name you had never seen. Projects with no sessions yet still open on a fresh chat.
  - Your other sessions are exactly where they were — this opens one tab, it does not rebuild an old layout.

### ko

프로젝트를 열면 하던 대화로 돌아가고, 메시지 속 파일 경로를 눌러서 바로 열 수 있어요.

**새로 생긴 것**

- 나비가 알려 준 파일 경로가 링크가 됐어요. 누르면 대화 옆에 문서가 열려요. 경로를 긁어서 복사하고 앱 밖으로 나가지 않아도, 방금 만들어 준 문서를 그 자리에서 읽을 수 있어요. 열어 둔 프로젝트 안이 아니어도 돼요.
  - 문서(\`.md\`, \`.markdown\`, \`.txt\`)만, 그리고 경로가 그대로 적혀 있을 때만 링크가 돼요. 누군가 직접 써 넣은 링크는 파일 링크로 바뀌지 않아요. 그래서 링크에 적힌 곳이 곧 열리는 곳이에요.
- 나비가 홈 폴더를 \`~\`로 줄이지 않고 경로를 끝까지 적어 줘요. 받은 경로를 그대로 누를 수 있게요.

**달라진 것**

- 프로젝트를 열면 마지막에 있던 대화가 그대로 떠요. 예전에는 열 때마다 빈 대화가 시작돼서, 작업이 쌓인 프로젝트가 빈 화면과 처음 보는 이름으로 사람을 맞았어요. 아직 대화가 없는 프로젝트는 예전처럼 새 대화로 열려요.
  - 다른 대화들은 있던 자리에 그대로 있어요. 탭 하나를 여는 것이지 예전 배치를 되살리는 게 아니에요.

## 1.29.0 — 2026-08-24

### en

The bar under the conversation shows what you can act on, and explains every figure it shows.

**New**

- Hover any figure in that bar and it says what it is. Turn input, output and the dollar amount had no explanation at all — they were numbers you either already understood or did not.
- **Cache hit** now says what it is made of: how much was read from the cache, how much was written to it this turn, and how much was sent uncached. What the cache holds is described in words, because which parts of it were reused is not something the API reports — so the tooltip states the three totals it can actually measure and does not guess at the rest.

**Changed**

- The bar is shorter by default. It keeps your plan usage, how full the conversation is, and any refusal — the three you can do something about. Turn input, output, cache hit and cost move behind a **+4** control at the right end, and one click brings them all back for good: the choice is remembered app-wide and survives a restart.
- A turn with none of those three to report now draws no bar at all, instead of a row of figures nobody asked for.

### ko

대화 아래 줄이 손쓸 수 있는 것만 보여 주고, 보여 주는 수치는 전부 스스로를 설명해요.

**새로 생긴 것**

- 그 줄의 어떤 수치든 위에 올리면 무엇인지 알려 줘요. 턴 입력과 출력과 금액은 설명이 아예 없어서, 알던 사람만 알던 숫자였어요.
- **캐시 적중**이 무엇으로 이루어졌는지 말해 줘요. 캐시에서 읽은 양, 이번 턴에 캐시에 기록한 양, 캐시 없이 보낸 양이에요. 캐시에 무엇이 담기는지는 문장으로 설명해요. 그 안에서 어느 부분이 재사용됐는지는 API가 알려 주지 않아서, 실제로 잴 수 있는 세 수치만 말하고 나머지는 짐작하지 않아요.

**달라진 것**

- 줄이 기본적으로 짧아졌어요. 플랜 사용량과 대화가 얼마나 찼는지와 거절당한 사실만 남겨요. 셋 다 손쓸 수 있는 것들이에요. 턴 입력·출력·캐시 적중·비용은 오른쪽 끝 **+4** 버튼 뒤로 들어가고, 한 번 누르면 계속 펼쳐진 채로 있어요. 이 선택은 앱 전체에 적용되고 앱을 껐다 켜도 남아요.
- 남길 것이 셋 다 없는 턴에서는 줄 자체가 그려지지 않아요. 아무도 찾지 않는 숫자만 남은 줄을 띄우지 않아요.

## 1.28.0 — 2026-08-24

### en

New sessions get a name you can read, and the sessions you could not close now close.

**New**

- A new session is called something like \`0824-1530-otter\` instead of a random id. Once the conversation has content the title comes from what you talked about, as before, and a name you type yourself is never overwritten.

**Fixed**

- A session with no project can be closed. Its ✕ was disabled because the delete went through a project-shaped request; sessions like these are created by ordinary use, so they had been accumulating with no way to remove them.
  - Closing one now also clears it from any window that had it open, which the old path could not do.
- The ✕ in **Recent sessions** is no longer hidden behind the preview panel. The panel was anchored inside the row, so hovering to reach the button was what covered it.
- The usage row no longer says the same thing twice. "Approaching Limit" repeated the weekly figure and its countdown; only an actual refusal is called out now.

### ko

새 세션에 읽을 수 있는 이름이 붙고, 닫을 수 없던 세션이 닫혀요.

**새로 생긴 것**

- 새 세션 이름이 난수 대신 \`0824-1530-otter\` 같은 형태예요. 대화가 시작되면 예전처럼 내용에서 제목을 뽑아 오고, 직접 지은 이름은 덮어쓰지 않아요.

**고친 것**

- 프로젝트가 없는 세션도 닫을 수 있어요. 삭제 요청이 프로젝트 단위로만 만들어져 있어서 ✕가 잠겨 있었는데, 이런 세션은 평소 사용 중에도 생기다 보니 지울 방법 없이 쌓이고 있었어요.
  - 이제 닫으면 그 세션을 열어 둔 창에서도 함께 정리돼요. 예전 경로로는 그게 안 됐어요.
- **최근 세션**의 ✕가 미리보기 패널에 가리지 않아요. 패널이 행 안쪽을 기준으로 열려서, 버튼을 누르러 다가가는 동작이 버튼을 덮고 있었어요.
- 사용량 줄이 같은 말을 두 번 하지 않아요. "Approaching Limit"이 주간 수치와 남은 시간을 그대로 반복했는데, 이제는 실제로 거절당했을 때만 알려 줘요.

## 1.27.0 — 2026-08-24

### en

How much of your plan is left, without asking.

**New**

- The bar under the conversation shows your Claude plan's 5-hour and weekly usage, each with the time until it resets. It is there before you send anything, and it refreshes when a turn finishes.
  - Per-model windows, when your account reports them, are in the tooltip rather than crowding the row.
  - Nothing is shown when the figure cannot be read. An absent number is not a zero.
- Hovering a row in **Recent sessions** reveals an ✕ on the right that closes that session in one click.
  - It deletes the conversation rather than hiding the row, and the tooltip says so.

### ko

플랜을 얼마나 썼는지, 물어보지 않아도 보여요.

**새로 생긴 것**

- 대화 아래 표시줄에 Claude 플랜의 5시간·주간 사용량이 남은 시간과 함께 떠요. 아무것도 보내지 않아도 보이고, 턴이 끝날 때마다 갱신돼요.
  - 계정이 모델별 사용량까지 알려주면 그건 툴팁에 넣어요. 한 줄에 다 늘어놓으면 읽기 어렵거든요.
  - 값을 읽지 못하면 아예 표시하지 않아요. 모르는 값을 0으로 적지는 않아요.
- **최근 세션** 목록에서 행에 마우스를 올리면 오른쪽에 ✕가 나타나고, 한 번 누르면 그 세션이 닫혀요.
  - 목록에서 감추는 게 아니라 대화가 삭제되며, 툴팁에도 그렇게 적혀 있어요.

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
