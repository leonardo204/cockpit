/**
 * Which rows the `/` and `@` palettes may show (Phase 3, P3-M2/M5).
 *
 * Extracted from ChatInput because this exact rule has now been wrong twice: the
 * first version showed agents under `/`, and the fix for that left commands
 * showing under `@` — rendered with the typed marker, so `/plan` appeared as
 * `@plan` and picking it produced a line the dispatcher could not read. Inline in
 * a `useMemo` it was invisible to tests; here it is one function with one test.
 *
 * THE RULE, stated once:
 *
 *   `/`  the harness — commands, skills, the things that expand into a prompt.
 *        An agent row must never appear, or picking it writes `@name` into a line
 *        the dispatcher reads as a harness verb.
 *   `@`  the agent layer — agents only. Not commands: a command reached through
 *        `@` would be dispatched as something else entirely.
 *
 * NOTE ON WHAT THIS REMOVES. Cockpit upstream treated `@verb` as "run this
 * command in a subagent session", which is why the query was marker-agnostic. In
 * naby `@` belongs to the agent layer (P3-M2), and the command dispatcher already
 * declines to expand `@<registeredAgent>`; keeping both meanings on one marker is
 * what produced the bug.
 */

/** The palette row shape this cares about — a superset of `CommandInfo`. */
export type PaletteRow = {
  name: string;
  /** Present only on naby agent rows (the server adds it). */
  agent?: { stage: string; percent: number; addressable: boolean };
};

/**
 * Split matched rows into the groups the palette renders, in order, for one
 * marker. Returns `agents` first because `@` is how the product's headline
 * feature is invoked; `commands` is always empty under `@`.
 */
export function partitionPaletteRows<T extends PaletteRow>(
  rows: readonly T[],
  marker: '/' | '@',
): { agents: T[]; commands: T[] } {
  if (marker === '@') {
    return { agents: rows.filter((r) => r.agent), commands: [] };
  }
  return { agents: [], commands: rows.filter((r) => !r.agent) };
}

/** The flat, ordered list the palette iterates. */
export function paletteRows<T extends PaletteRow>(rows: readonly T[], marker: '/' | '@'): T[] {
  const { agents, commands } = partitionPaletteRows(rows, marker);
  return [...agents, ...commands];
}
