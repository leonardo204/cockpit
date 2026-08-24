/**
 * sessionName — the human-readable DEFAULT name of a session nobody has named.
 *
 * WHAT THIS REPLACES. A session with no title used to surface as its own id:
 * `Session s-mt16...` in the tab strip, `(제목 없음) s-mt167d` on Telegram, a
 * bare `sessionId.slice(0, 8)` in the sidebar. An id is an identity, not a
 * label — it is unreadable, unsayable, and two of them look alike.
 *
 * THE SHAPE IS `MMDD-HHmm-animal` (e.g. `0824-1530-otter`), which is the user's
 * requested order — date, time, animal — under three constraints:
 *
 *   1. It is ONE token: no space, no `·`, no `/`, no `:`. Both the recent list
 *      and the Telegram session list join metadata with `·` (`프로젝트 · 제목 ·
 *      시간`), so a name containing the joiner would read as two fields.
 *   2. The numeric part is FIXED WIDTH, so lexicographic order is chronological
 *      order and a column of these lines up. The year is deliberately absent:
 *      15 characters fit a narrow tab where a full ISO stamp does not, and this
 *      is a label for a session created moments ago, not an archive key.
 *   3. It is 15 characters, so the tab strip (`truncate`, max 260px) shows all
 *      of it. Squeezed to its `min-w-16` floor the animal is what gets cut —
 *      the cost of the requested field order, and the reason the numeric prefix
 *      is 9 characters rather than a spelled-out date.
 *
 * IT IS NOT STORED, AND THAT IS THE DESIGN. This name is a placeholder for an
 * EMPTY session, not a permanent label: the moment the conversation has a first
 * message, the ordinary derived title takes over, and the moment the user
 * renames the tab, their name wins forever. Writing this into `sessions.title`
 * would freeze it at stage one, because every reader prefers a stored title
 * over a derived one (see `deriveTitle`). So it is computed, at the point of
 * display, from two facts the session row already carries — `createdAt` and
 * `sessionId` — and every surface therefore agrees without anything being
 * written down or kept in sync.
 *
 * Uniqueness is NOT load-bearing. Two sessions minted in the same minute with
 * colliding animals share a label; the id remains the identity and nothing
 * looks a session up by this string. No caller scans the session table to
 * avoid a collision.
 */

/**
 * The words a default name may end with.
 *
 * SELECTION RULE, because this string is shown to the user and is sent to
 * Telegram: common English animal nouns only — one word, no adjectives, no
 * compounds, nothing that doubles as an insult, a slur, or a joke in English or
 * Korean. Words that are equally a verb or a machine (`seal`, `crane`, `swift`,
 * `swallow`) are left out because the label must read as a name, and animals
 * used to belittle a person (`pig`, `rat`, `sloth`, `weasel`, `turkey`) are
 * left out because a name attached to your own work should not be a comment on
 * it.
 *
 * Kept short on purpose — 32 words is enough to tell apart the handful of
 * unnamed sessions that exist at one time, and a longer list only adds words
 * that had to pass the rule above with less scrutiny. Alphabetical so a reader
 * can check for a duplicate at a glance. Appending is safe; REORDERING or
 * REMOVING changes the name a given session shows, so do neither.
 */
export const SESSION_NAME_ANIMALS = [
  'alpaca',
  'bison',
  'camel',
  'cheetah',
  'dolphin',
  'eagle',
  'falcon',
  'finch',
  'fox',
  'gecko',
  'giraffe',
  'hedgehog',
  'heron',
  'koala',
  'lemur',
  'llama',
  'lynx',
  'meerkat',
  'moose',
  'otter',
  'owl',
  'panda',
  'pelican',
  'penguin',
  'puffin',
  'puma',
  'squirrel',
  'tapir',
  'tiger',
  'turtle',
  'walrus',
  'wolf',
] as const;

/** CRC32, the same polynomial `shortId.ts` uses. Duplicated as a private helper
 *  rather than imported so this module stays free of any other import — it is
 *  pulled into the client bundle, the server routes and the Telegram renderer
 *  alike. */
function crc32(input: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The animal for a seed — a HASH, never `Math.random()`.
 *
 * The name has to come out the same in the tab strip, the recent list, the
 * session browser and Telegram, none of which can ask the others what they
 * chose. A random pick would need to be stored somewhere for that; a hash of
 * the session id needs nothing, and is the same answer in every process for as
 * long as the session exists.
 */
export function sessionNameAnimal(seed: string): string {
  const words = SESSION_NAME_ANIMALS;
  // The modulo is in range by construction; the `?? words[0]` is what satisfies
  // `noUncheckedIndexedAccess` without an assertion, and is unreachable.
  return words[crc32(seed) % words.length] ?? words[0];
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/**
 * `MMDD-HHmm` for a moment, in the reader's OWN timezone.
 *
 * Local, not UTC: the point of putting a clock in the name is that the user
 * recognises when they made it, and a session made at 15:30 that calls itself
 * 0630 is worse than no time at all.
 */
export function formatSessionNameStamp(createdAt: number): string {
  const d = new Date(createdAt);
  return `${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

/**
 * The default name of a session created at `createdAt`, identified by `seed`.
 *
 * PURE, and both of its inputs are supplied by the caller: no `Date.now()` and
 * no `Math.random()` live in here, so a test fixes the clock by passing one and
 * fixes the animal by passing a seed.
 *
 * `seed` is the session id wherever one exists — that is what makes every
 * surface agree. A tab that has not created its session yet has no id and seeds
 * with its own tab id instead; that name is replaced by the derived title on
 * the first turn, exactly like the one it would have had.
 */
export function defaultSessionName(seed: string, createdAt: number): string {
  return `${formatSessionNameStamp(createdAt)}-${sessionNameAnimal(seed)}`;
}

/**
 * The mint time encoded in a runtime session id, or undefined for an id this
 * runtime did not mint.
 *
 * WHY THIS IS HERE. The tab strip is handed a bare session id — from the URL on
 * a reload, or from a list row that carried no title — and has no `createdAt`
 * to format. It could invent one from its own clock, but then a session opened
 * today would announce itself as created today no matter how old it is, and the
 * tab would disagree with every list showing the same session. The id already
 * carries the answer: `mintSessionId` builds `s-<base36 Date.now()>-<n>-<rand>`.
 *
 * HONEST PRECISION. The store reads its `now` for the row one statement before
 * the id reads its own, so the two can straddle a millisecond — and only a
 * straddle that also crosses a minute boundary changes the printed name, which
 * the server's answer overwrites within the same page load anyway. Anything
 * that is not a runtime id (a provider UUID, a made-up test id) returns
 * undefined rather than a guess.
 */
export function sessionCreatedAtFromId(sessionId: string): number | undefined {
  const stamp = /^s-([0-9a-z]+)-/.exec(sessionId)?.[1];
  if (!stamp) return undefined;
  const ms = parseInt(stamp, 36);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}
