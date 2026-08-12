/**
 * WHERE A `/` MEANS THE HARNESS, AND WHERE IT IS JUST A SLASH.
 *
 * One rule, one file, two readers — which is the whole point of putting it in
 * `shared/`:
 *
 *   * the composer (`client/ChatInput.tsx`) asks "should the palette open at the
 *     caret, and which span does a picked row replace";
 *   * the dispatcher (`server/engines/naby.ts`) asks "which harness rows did the
 *     user NAME in this message".
 *
 * Those two questions have to agree. Before this module they did not even have
 * the same shape: the palette matched the WHOLE LINE against a start-anchored
 * verb pattern, so a `/plan-review` written mid-sentence offered no completion
 * and, on send, meant
 * nothing — while `@` mentions had been mid-sentence-capable since file
 * mentions landed. A marker that works at the start of a line and silently does
 * nothing four words later is not a rule anyone can hold in their head.
 *
 * THE ANCHOR, stated once: a `/` opens the harness only when it starts the input
 * or FOLLOWS WHITESPACE, and only when what follows it is verb-shaped. That is
 * the same anchor `findMentionQuery` uses for `@`, and it is what keeps the
 * three shapes people actually type from ever being read as a command:
 *
 *   src/foo      the `/` follows `c`   — a path segment
 *   https://a/b  the `/` follows `/`   — a URL
 *   08/12        the `/` follows `8`   — a date
 *
 * WHAT IS DELIBERATELY NOT HERE. Nothing in this module knows which verbs exist:
 * that answer lives in the harness (`app.db`) and is read by the palette and by
 * the injector. A name nobody registered is simply a token no reader claims —
 * no warning, no expansion, plain text.
 */

/** Characters a harness verb may be made of, AFTER the first one. Kept in sync
 *  with the server dispatcher's COMMAND_LINE_RE (`lib/slashCommands.ts`). */
const VERB_TAIL = 'a-zA-Z0-9-';

/** What is allowed between the `/` and the caret while the user is still typing:
 *  the verb characters, and nothing else. Empty is allowed — a bare `/` opens
 *  the full list, which is how the palette has always behaved. */
const PARTIAL_VERB_RE = new RegExp(`^[${VERB_TAIL}]*$`);

/** A COMPLETE verb, as the dispatcher recognises it: a letter, then verb tail
 *  characters. The leading-letter rule is the server's, so `/2024-plan` in a
 *  sentence is not read as naming anything. */
const COMPLETE_VERB_RE = new RegExp(`^[a-zA-Z][${VERB_TAIL}]*$`);

/** Every `/verb` in a message that sits at the start of the text or after
 *  whitespace. The capture before the slash is what anchors it. */
const SLASH_TOKEN_RE = new RegExp(`(^|\\s)/([a-zA-Z][${VERB_TAIL}]*)`, 'g');

/** The `/…` being typed at the caret, with the absolute span it occupies.
 *  The span matters for the same reason it does for a mention: the token is
 *  usually MID-SENTENCE, so replacing the whole line would delete the words
 *  around it. */
export type SlashQuery = {
  /** Index of the `/` itself. */
  start: number;
  /** Index just past the END OF THE TOKEN — the caret when typing forward, and
   *  past it when the caret was parked inside a verb already written. */
  end: number;
  /** What has been typed BEFORE the caret, lowercased — the prefix to filter the
   *  palette by. May be empty. */
  verb: string;
};

/**
 * Find the harness token being typed at the caret, or null.
 *
 * Mirrors `findMentionQuery` deliberately: the anchor is the same, and what is
 * typed before the caret is the prefix the palette filters by.
 *
 * WHERE IT DOES NOT MIRROR IT — the span runs to the end of the TOKEN, not to
 * the caret. Typing forward those are the same character, which is the case that
 * is not an edge case. They differ only when the caret was clicked back into a
 * verb that is already written, and there the token end is what preserves the
 * behaviour the line-replacing version had: picking a row from `/pl|an` writes
 * `/plan `, not `/plan an` with the tail stranded.
 *
 * A `/` inside a word (a path, a URL, a date) is rejected by the whitespace
 * anchor; anything non-verb-shaped between the `/` and the caret (a space, a
 * second slash, a dot) ends the token, which is what closes the menu when the
 * user carries on writing the sentence.
 */
export function findSlashQuery(input: string, caret: number): SlashQuery | null {
  const upto = input.slice(0, Math.max(0, Math.min(caret, input.length)));
  const at = upto.lastIndexOf('/');
  if (at === -1) return null;
  // Start of input or preceded by whitespace — never by a word character, which
  // is what a path segment, a URL and a date all look like.
  if (at > 0 && !/\s/.test(input[at - 1]!)) return null;
  const text = upto.slice(at + 1);
  if (!PARTIAL_VERB_RE.test(text)) return null;
  let end = upto.length;
  while (end < input.length && PARTIAL_VERB_RE.test(input[end]!)) end += 1;
  return { start: at, end, verb: text.toLowerCase() };
}

/** The text a picked harness row inserts over its own span. A trailing space,
 *  because the token is finished and the sentence continues — the same shape a
 *  picked FILE mention uses. */
export function slashInsertion(name: string): string {
  return `/${name} `;
}

/** One `/verb` found in a message. `lineLed` is the distinction everything
 *  downstream turns on: a line-led verb is the classic command the dispatcher
 *  EXPANDS into a prompt, and a mid-sentence one is a mention of a harness row
 *  inside a sentence that must survive intact. */
export type SlashToken = {
  start: number;
  end: number;
  /** The verb, lowercased, without the slash. */
  verb: string;
  /** Whether only whitespace stands between the start of its line and the `/`. */
  lineLed: boolean;
};

/** Whether only whitespace separates `index` from the start of its line — the
 *  client-side twin of the dispatcher's `^\s*` anchor. */
function isLineLed(text: string, index: number): boolean {
  const lineStart = index === 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1;
  return /^\s*$/.test(text.slice(lineStart, index));
}

/** Every anchored `/verb` in a message, in the order written. */
export function slashTokens(text: string): SlashToken[] {
  const out: SlashToken[] = [];
  SLASH_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SLASH_TOKEN_RE.exec(text)) !== null) {
    const verb = m[2]!;
    // `m.index` points at the anchor character (start-of-string is empty), so
    // the slash is that plus the anchor's length.
    const start = m.index + m[1]!.length;
    out.push({
      start,
      end: start + 1 + verb.length,
      verb: verb.toLowerCase(),
      lineLed: isLineLed(text, start),
    });
  }
  return out;
}

/**
 * The harness rows a message NAMES mid-sentence, de-duplicated, in the order
 * they were written.
 *
 * LINE-LED VERBS ARE EXCLUDED ON PURPOSE. A `/verb` that leads its line is the
 * dispatcher's business (`resolveCommandPrompt` already expanded it into the
 * prompt text before the turn ran); counting it here as well would inject the
 * same body twice. So this returns exactly the tokens the old rule dropped on
 * the floor — and the old behaviour is left byte-for-byte alone.
 */
export function namedHarnessRows(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of slashTokens(text)) {
    if (token.lineLed) continue;
    if (!COMPLETE_VERB_RE.test(token.verb)) continue;
    if (seen.has(token.verb)) continue;
    seen.add(token.verb);
    out.push(token.verb);
  }
  return out;
}
