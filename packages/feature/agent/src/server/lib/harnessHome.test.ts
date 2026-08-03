import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpEntry } from '../../../../../../../dist/naby-runtime.mjs';
import {
  canSteerInstalls,
  harnessHomeInstruction,
  projectHarnessHome,
  userHarnessHome,
  HARNESS_CONTENT_DIRS,
} from './harnessHome';
import { SKILL_HUB_SERVER_NAME } from './systemMcp';

const HOME = '/home/me';

function store(entries: McpEntry[] = []) {
  return { listMcpEntries: (): McpEntry[] => entries };
}

const hubEntry: McpEntry = {
  name: SKILL_HUB_SERVER_NAME,
  transport: 'http',
  url: 'https://skills.altimedia.com/mcp',
};

// ---------------------------------------------------------------------------
// The paths
// ---------------------------------------------------------------------------

describe('harness home paths', () => {
  it('user home is <home>/.naby', () => {
    expect(userHarnessHome(HOME)).toBe('/home/me/.naby');
  });

  it('project home is <cwd>/.naby, and undefined with no open project', () => {
    expect(projectHarnessHome('/proj')).toBe('/proj/.naby');
    expect(projectHarnessHome(undefined)).toBeUndefined();
  });

  it('holds exactly the three content directories', () => {
    expect([...HARNESS_CONTENT_DIRS].sort()).toEqual(['agents', 'commands', 'skills']);
  });
});

// ---------------------------------------------------------------------------
// The instruction text
// ---------------------------------------------------------------------------

describe('harnessHomeInstruction', () => {
  it('names BOTH homes when a project is open', () => {
    const text = harnessHomeInstruction('/proj', HOME);
    expect(text).toContain('/home/me/.naby');
    expect(text).toContain('/proj/.naby');
  });

  it('names only the user home when no project is open', () => {
    const text = harnessHomeInstruction(undefined, HOME);
    expect(text).toContain('/home/me/.naby');
    expect(text).not.toContain('/proj/.naby');
  });

  it('tells the model to SUBSTITUTE a vendor path rather than obey it', () => {
    const text = harnessHomeInstruction(undefined, HOME).toLowerCase();
    // The whole point: install instructions in the wild say ~/.claude.
    expect(text).toContain('~/.claude');
    expect(text).toMatch(/substitute/);
  });

  it('keeps the ecosystem layout below the base directory', () => {
    const text = harnessHomeInstruction(undefined, HOME);
    expect(text).toContain('skills/<name>/SKILL.md');
    expect(text).toContain('commands/<name>.md');
    expect(text).toContain('agents/<name>.md');
  });

  it('says an install arrives disabled — the trust rule the gate enforces', () => {
    const text = harnessHomeInstruction(undefined, HOME).toLowerCase();
    expect(text).toContain('disabled');
  });

  it('stays short enough to share a system prompt (a handful of lines)', () => {
    expect(harnessHomeInstruction('/proj', HOME).split('\n').length).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('canSteerInstalls', () => {
  it('is off with no MCP entries at all', () => {
    expect(canSteerInstalls(store())).toBe(false);
  });

  it('is off when the only entries are other servers', () => {
    expect(
      canSteerInstalls(store([{ name: 'atlassian', transport: 'stdio', command: '/usr/bin/uvx' }])),
    ).toBe(false);
  });

  it('is ON with an enabled skill-hub entry', () => {
    expect(canSteerInstalls(store([hubEntry]))).toBe(true);
  });

  it('is OFF for a merely PROPOSED skill-hub entry (nothing is loaded yet)', () => {
    expect(canSteerInstalls(store([{ ...hubEntry, status: 'proposed' }]))).toBe(false);
  });

  it('survives a registry read that throws — a broken read drops the words, not the turn', () => {
    expect(
      canSteerInstalls({
        listMcpEntries: () => {
          throw new Error('db is gone');
        },
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The wiring.
//
// A source assertion, because the composition it guards is inside `run()`'s turn
// loop — reachable only by standing up a whole engine, provider and store. What
// must not silently rot is the PAIRING: the instruction is composed into
// `turnSystem`, and it is composed under the gate rather than unconditionally.
// ---------------------------------------------------------------------------

describe('naby engine wiring', () => {
  const source = readFileSync(join(__dirname, '../engines/naby.ts'), 'utf8');

  it('imports the helper and its gate', () => {
    expect(source).toContain("from '../lib/harnessHome'");
    expect(source).toContain('canSteerInstalls');
  });

  it('composes the instruction into turnSystem, gated', () => {
    const line = source
      .split('\n')
      .find((l) => l.includes('harnessHomeInstruction(') && !l.startsWith('import'));
    expect(line).toBeDefined();
    // Conditional — same shape as the learning / check-in instructions beside it.
    expect(line).toMatch(/\?\s*harnessHomeInstruction\(/);
  });
});
