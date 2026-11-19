// packages/feature/agent/src/client/readingPosition.ts
//
// KEEP A DETACHED READER WHERE THEY ARE WHEN HISTORY CHANGES ABOVE THEM.
//
// Field report (2026-11-19): "스크롤을 살짝 올려서 답변을 보는 중에 새로운 나비의
// 응답이 오면 스크롤이 세션의 맨 처음 위로 올라간다." Reproduced in an isolated build:
// the turn-end reconcile replaced the list with the whole transcript, ~100k px of
// history appeared ABOVE the viewport, and scrollTop stayed where it was — so the
// reader was suddenly looking at old history. The browser's scroll anchoring is
// what normally absorbs an insertion above; it failed here because the anchor
// it had chosen was the in-progress `live-…` bubble, which the same commit
// replaced with its disk copy.
//
// So this is done in code, not left to the browser: when the reader is NOT
// pinned to the bottom and the FIRST rendered message changes (older messages
// were prepended, or the list was replaced), keep the distance from the
// viewport's top to the content's bottom. What is at the bottom (the newest
// turn) is the same either side of a reconcile, so the same text stays in view.
//
// Pinned readers are left to the stick-to-bottom machine, and the "load older
// history" restore has its own rule; both are excluded by the caller.

export interface ReadingSnapshot {
  /** Id of the first rendered message when the snapshot was taken. */
  firstId: string | undefined;
  /** scrollHeight - scrollTop: from the viewport's top to the content's end. */
  fromBottom: number;
}

export function takeSnapshot(firstId: string | undefined, m: { scrollTop: number; scrollHeight: number }): ReadingSnapshot {
  return { firstId, fromBottom: m.scrollHeight - m.scrollTop };
}

/**
 * The scrollTop that keeps the reader in place, or null to leave it alone:
 * pinned, nothing to compare against, or the top of the list did not change
 * (a streamed delta or a reconcile of the newest turn only — those change the
 * bottom, which the browser handles and the reader is not looking at).
 */
export function readingPositionAfter(
  prev: ReadingSnapshot | null,
  next: { firstId: string | undefined; scrollHeight: number; clientHeight: number },
  pinned: boolean,
): number | null {
  if (pinned || !prev || prev.firstId === undefined || next.firstId === prev.firstId) return null;
  const top = next.scrollHeight - prev.fromBottom;
  return Math.max(0, Math.min(top, Math.max(0, next.scrollHeight - next.clientHeight)));
}
