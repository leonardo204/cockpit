// packages/shared/ui/src/asciiArt.ts
//
// FENCE ONLY THE DIAGRAM, NEVER THE MESSAGE.
//
// An unfenced box drawing or directory tree collapses into one paragraph when
// rendered as markdown, so a finished reply gets its diagram blocks wrapped in a
// ```text fence. This used to wrap the WHOLE reply as soon as one suspicious
// character appeared anywhere: a single "▲948%" in the last line of a long
// report turned every heading, list and bold span into raw markdown (field case
// 2026-11-13). It also looked like flicker — streaming skips this step, so the
// reply rendered fine and then went raw the moment it finished.
//
// Now the reply is split into blank-line-separated blocks outside existing
// fences, and only blocks that look like a drawing are fenced. A drawing needs
// several lines of evidence; one glyph in a sentence is never enough, and the
// arrow/triangle glyphs (▲▼▶…) do not count at all — prose uses them for deltas
// and bullets.

/** Box-drawing glyphs. Arrows and triangles are deliberately absent. */
const BOX_CHARS = /[┌┐└┘│─├┤┬┴┼╔╗╚╝║═╭╮╯╰]/;
const ASCII_BORDER = /\+[-=]{2,}\+/;
/** A table separator row: pipes, colons and spaces around at least one dash. */
const TABLE_SEPARATOR = /^\s*\|[\s:|-]*-[\s:|-]*\|\s*$/m;
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;

function isDrawing(block: string[]): boolean {
  const text = block.join('\n');
  // A markdown table may carry box glyphs in its cells; it renders fine as is.
  if (TABLE_SEPARATOR.test(text)) return false;

  if (block.filter((l) => BOX_CHARS.test(l)).length >= 2) return true;
  if (block.filter((l) => ASCII_BORDER.test(l)).length >= 2) return true;

  // Pipe-framed boxes: at least 3 lines starting or ending with |, unless the
  // pipe counts agree and show 2+ columns (a table missing its separator row).
  const pipeLines = block.filter((l) => /^\s*\||\|\s*$/.test(l));
  if (pipeLines.length >= 3) {
    const counts = pipeLines.map((l) => (l.match(/\|/g) ?? []).length);
    const sameShape = counts.every((c) => c === counts[0]);
    return !(sameShape && counts[0]! >= 3);
  }
  return false;
}

type Segment = { kind: 'fence' | 'blank' | 'block'; lines: string[] };

function segment(content: string): Segment[] {
  const lines = content.split('\n');
  const out: Segment[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const open = FENCE_OPEN.exec(line);
    if (open) {
      const marker = open[1]!;
      const close = new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      const fence = [line];
      i += 1;
      while (i < lines.length) {
        fence.push(lines[i]!);
        i += 1;
        if (close.test(fence[fence.length - 1]!)) break;
      }
      out.push({ kind: 'fence', lines: fence });
      continue;
    }
    if (line.trim() === '') {
      out.push({ kind: 'blank', lines: [line] });
      i += 1;
      continue;
    }
    const block: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !FENCE_OPEN.test(lines[i]!)) {
      block.push(lines[i]!);
      i += 1;
    }
    out.push({ kind: 'block', lines: block });
  }
  return out;
}

/**
 * Wrap each drawing in a ```text fence and leave everything else as markdown.
 * Adjacent drawings separated only by blank lines share one fence, so a diagram
 * with an empty row inside it stays one picture. Returns the input unchanged
 * when nothing looks like a drawing.
 */
export function fenceAsciiArt(content: string): string {
  if (!BOX_CHARS.test(content) && !ASCII_BORDER.test(content) && !content.includes('|')) {
    return content;
  }
  const segs = segment(content);
  const drawing = segs.map((s) => s.kind === 'block' && isDrawing(s.lines));
  if (!drawing.some(Boolean)) return content;

  const out: string[] = [];
  let i = 0;
  while (i < segs.length) {
    if (!drawing[i]) {
      out.push(...segs[i]!.lines);
      i += 1;
      continue;
    }
    // Extend over blank lines only when another drawing follows them.
    let end = i;
    let j = i + 1;
    while (j < segs.length && (segs[j]!.kind === 'blank' || drawing[j])) {
      if (drawing[j]) end = j;
      j += 1;
    }
    const body = segs.slice(i, end + 1).flatMap((s) => s.lines);
    out.push('```text', ...body, '```');
    i = end + 1;
  }
  return out.join('\n');
}
