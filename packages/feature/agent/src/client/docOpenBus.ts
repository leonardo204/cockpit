// A tiny same-window channel that lets a message bubble open a document in a
// tab.
//
// WHY A BUS AND NOT A PROP. The path is rendered deep inside the conversation
// (TabManager → ChatPanel → Chat → MessageBubble), and the thing that can open a
// tab is the tab host at the top. Threading a callback down that chain would put
// a new prop on four components, and MessageBubble is `memo`'d against exactly
// this kind of churn (shell/CLAUDE.md, React conventions) — one unstable
// callback in that chain silently defeats the memo the whole message list
// depends on.
//
// WHY NOT A TOPIC. `Topics` is for messages that cross the iframe boundary. This
// one does not: the file browser, the chat and the tab bar are all inside the
// same per-project frame, and the tab host is a React ancestor of the bubble.
// Publishing to `window.parent` for a same-frame call would be a longer road to
// the same place, through a boundary that adds only failure modes.
//
// It is deliberately shaped like `fileRefBus.ts` beside it — the same singleton,
// the same identity-checked release — because it is the same problem in the
// other direction: that one lets the file browser reach the active chat input,
// this one lets a chat message reach the tab host.
//
// SINGLE REGISTRANT, NOT A BROADCAST. Every open tab keeps its conversation
// mounted, so a broadcast would be answered by every tab at once. There is one
// tab host per frame and it registers once, which is also why this needs no
// activation dance: unlike the chat input, the host does not come and go with
// the active tab.

/** Where a document tab opens: the root it is read against, and the path within
 *  it. Mirrors what `openMarkdownTab(cwd, rel)` takes — see `docTabTarget` in
 *  `@cockpit/shared-ui` for how an absolute path is split into the pair, and why
 *  a document outside the project is opened against its own folder. */
export interface DocOpenRequest {
  cwd: string
  rel: string
}

type Opener = (req: DocOpenRequest) => void

let activeOpener: Opener | null = null

/** The tab host registers its "open this document in a tab" function. */
export function setActiveDocOpener(fn: Opener): void {
  activeOpener = fn
}

/** Relinquish, but only if `fn` is still the registered opener — the same
 *  identity check `fileRefBus` uses, so a remount whose effect ordering puts the
 *  new registration before the old cleanup does not end up with no opener at
 *  all. */
export function clearActiveDocOpener(fn: Opener): void {
  if (activeOpener === fn) activeOpener = null
}

/**
 * Open a document in a tab. Returns whether a host handled it.
 *
 * `false` means nothing is mounted that can open tabs — which is a real state
 * (a message rendered outside the tab host, e.g. in a preview). The CALLER still
 * treats the click as consumed: the href is a filesystem path, and letting the
 * anchor navigate to it would take the shell to `http://localhost:PORT/Users/…`
 * and lose the conversation. Better a click that does nothing than one that
 * throws the session away.
 */
export function openDocumentInTab(req: DocOpenRequest): boolean {
  if (!activeOpener) return false
  activeOpener(req)
  return true
}
