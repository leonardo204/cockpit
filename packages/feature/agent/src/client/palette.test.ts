import { describe, it, expect } from 'vitest';
import { paletteRows, partitionPaletteRows, type PaletteRow } from './palette';

/**
 * The `/` and `@` palettes must not show each other's rows. This has been wrong
 * twice — agents under `/` first, then commands under `@` — so both directions are
 * pinned here rather than left to a component nobody can unit-test.
 */

const agent = (name: string, addressable = true): PaletteRow => ({
  name,
  agent: { stage: addressable ? 'butterfly' : 'egg', percent: addressable ? 100 : 0, addressable },
});
const command = (name: string): PaletteRow => ({ name });

const ROWS: PaletteRow[] = [
  command('/plan'),
  agent('@persona', false),
  command('/qa'),
  agent('@reviewer'),
  command('/fx'),
];

describe('palette rows — the two markers never share a list', () => {
  it('@ shows agents only, and never a command', () => {
    const { agents, commands } = partitionPaletteRows(ROWS, '@');
    expect(agents.map((r) => r.name)).toEqual(['@persona', '@reviewer']);
    expect(commands).toEqual([]);
    // The bug this exists for: `/plan` rendered as `@plan`, which the dispatcher
    // cannot read as anything.
    expect(paletteRows(ROWS, '@').map((r) => r.name)).toEqual(['@persona', '@reviewer']);
  });

  it('/ shows commands only, and never an agent', () => {
    const { agents, commands } = partitionPaletteRows(ROWS, '/');
    expect(agents).toEqual([]);
    expect(commands.map((r) => r.name)).toEqual(['/plan', '/qa', '/fx']);
    // Picking an agent under `/` would write `@name` into a line read as a
    // harness verb.
    expect(paletteRows(ROWS, '/').some((r) => r.agent)).toBe(false);
  });

  it('agents come first, so the headline feature is not buried', () => {
    // Order matters even though `@` currently yields only agents: the flat list
    // is what the keyboard cursor walks, and index 0 must be an agent.
    expect(paletteRows(ROWS, '@')[0]?.name).toBe('@persona');
  });

  it('a NON-ADDRESSABLE agent is still listed under @', () => {
    // Listed but greyed and unselectable (ChatInput's isSelectable) — hiding it
    // would leave the user with no way to see that the persona exists and is
    // still growing.
    expect(paletteRows([agent('@persona', false)], '@')).toHaveLength(1);
  });

  it('an empty match list stays empty rather than falling back to the other marker', () => {
    expect(paletteRows([], '@')).toEqual([]);
    expect(paletteRows([command('/qa')], '@')).toEqual([]);
    expect(paletteRows([agent('@persona')], '/')).toEqual([]);
  });
});
