import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessItem } from '../../../../../../../dist/naby-runtime.mjs';
import {
  deleteHarnessSource,
  nabyHarnessBases,
  planHarnessDelete,
  strictlyWithin,
  type HarnessDeletePlan,
} from './harnessSource';

function row(over: Partial<HarnessItem> = {}): Pick<HarnessItem, 'scope' | 'scopeKey' | 'provenance'> {
  return {
    scope: 'user',
    scopeKey: 'local',
    provenance: { source: 'external' },
    ...over,
  } as Pick<HarnessItem, 'scope' | 'scopeKey' | 'provenance'>;
}

function sourcePlan(plan: HarnessDeletePlan) {
  if (plan.tier !== 'source') throw new Error(`expected a source plan, got ${plan.tier}`);
  return plan;
}

describe('nabyHarnessBases', () => {
  it('user scope resolves to <home>/.naby', () => {
    expect(nabyHarnessBases({ scope: 'user', scopeKey: 'local', homeDir: '/home/me' })).toEqual([
      '/home/me/.naby',
    ]);
  });

  it('project scope resolves to <cwd>/.naby (the scopeKey IS the cwd)', () => {
    expect(nabyHarnessBases({ scope: 'project', scopeKey: '/work/app' })).toEqual([
      '/work/app/.naby',
    ]);
  });

  it('a project scopeKey that is not an absolute path yields NO base', () => {
    // Resolving it against whatever cwd the server has would invent a directory.
    expect(nabyHarnessBases({ scope: 'project', scopeKey: 'app' })).toEqual([]);
  });

  it('org scope has no on-disk home, so every org row is tier 2', () => {
    expect(nabyHarnessBases({ scope: 'org', scopeKey: 'default' })).toEqual([]);
  });

  it('never lists `.claude` — a vendor file must be unnameable by the deleter', () => {
    const bases = nabyHarnessBases({ scope: 'user', scopeKey: 'local', homeDir: '/home/me' });
    expect(bases.some((b) => b.includes('.claude'))).toBe(false);
  });
});

describe('strictlyWithin', () => {
  it('accepts a path strictly inside', () => {
    expect(strictlyWithin('/home/me/.naby', '/home/me/.naby/skills/x')).toBe(true);
  });
  it('refuses the base itself', () => {
    expect(strictlyWithin('/home/me/.naby', '/home/me/.naby')).toBe(false);
  });
  it('refuses a sibling whose name merely starts the same', () => {
    expect(strictlyWithin('/home/me/.naby', '/home/me/.naby-old/x')).toBe(false);
  });
  it('refuses an ancestor reached with ..', () => {
    expect(strictlyWithin('/home/me/.naby', '/home/me/.naby/../../.claude/x')).toBe(false);
  });
});

describe('planHarnessDelete — which tier, and what would be unlinked', () => {
  it('a canonical skill under the naby home removes the whole skill DIRECTORY', () => {
    const plan = planHarnessDelete(
      row({ provenance: { source: 'external', origin: '/home/me/.naby/skills/review/SKILL.md' } }),
      { homeDir: '/home/me' },
    );
    expect(sourcePlan(plan)).toMatchObject({
      target: '/home/me/.naby/skills/review',
      recursive: true,
      base: '/home/me/.naby',
    });
  });

  it('a PACK skill removes only the <skill> directory, not the pack', () => {
    const plan = planHarnessDelete(
      row({
        provenance: {
          source: 'external',
          origin: '/home/me/.naby/skills/office/docx/SKILL.md',
        },
      }),
      { homeDir: '/home/me' },
    );
    expect(sourcePlan(plan).target).toBe('/home/me/.naby/skills/office/docx');
  });

  it('a FLAT skill .md removes just the file', () => {
    const plan = planHarnessDelete(
      row({ provenance: { source: 'external', origin: '/home/me/.naby/skills/quick.md' } }),
      { homeDir: '/home/me' },
    );
    expect(sourcePlan(plan)).toMatchObject({
      target: '/home/me/.naby/skills/quick.md',
      recursive: false,
    });
  });

  it('a namespaced command removes just the file, never its folder', () => {
    const plan = planHarnessDelete(
      row({ provenance: { source: 'external', origin: '/home/me/.naby/commands/git/commit.md' } }),
      { homeDir: '/home/me' },
    );
    expect(sourcePlan(plan)).toMatchObject({
      target: '/home/me/.naby/commands/git/commit.md',
      recursive: false,
    });
  });

  it('an agent .md removes just the file', () => {
    const plan = planHarnessDelete(
      row({ provenance: { source: 'external', origin: '/home/me/.naby/agents/critic.md' } }),
      { homeDir: '/home/me' },
    );
    expect(sourcePlan(plan).target).toBe('/home/me/.naby/agents/critic.md');
  });

  it('a project-scope item resolves against its cwd', () => {
    const plan = planHarnessDelete(
      row({
        scope: 'project',
        scopeKey: '/work/app',
        provenance: { source: 'external', origin: '/work/app/.naby/skills/lint/SKILL.md' },
      }),
      { homeDir: '/home/me' },
    );
    expect(sourcePlan(plan).target).toBe('/work/app/.naby/skills/lint');
  });

  // -- tier 2: everything that must NOT be unlinked ------------------------

  it('a `.claude` origin is a TOMBSTONE — the vendor file is not ours', () => {
    expect(
      planHarnessDelete(
        row({
          provenance: { source: 'external', origin: '/home/me/.claude/skills/review/SKILL.md' },
        }),
        { homeDir: '/home/me' },
      ),
    ).toEqual({ tier: 'tombstone', reason: 'outside-naby-home' });
  });

  it('no origin at all (a user-authored command) is a tombstone', () => {
    expect(planHarnessDelete(row({ provenance: { source: 'user' } }))).toEqual({
      tier: 'tombstone',
      reason: 'no-origin',
    });
  });

  it('a non-path origin (a set import) is a tombstone', () => {
    expect(
      planHarnessDelete(row({ provenance: { source: 'external', origin: 'set:team@1.0' } })),
    ).toEqual({ tier: 'tombstone', reason: 'no-origin' });
  });

  it('another project’s naby home is not this row’s to delete', () => {
    expect(
      planHarnessDelete(
        row({
          scope: 'project',
          scopeKey: '/work/app',
          provenance: { source: 'external', origin: '/work/other/.naby/skills/x/SKILL.md' },
        }),
      ),
    ).toEqual({ tier: 'tombstone', reason: 'outside-naby-home' });
  });

  it('a `..` escape written into the origin is refused', () => {
    expect(
      planHarnessDelete(
        row({
          provenance: {
            source: 'external',
            origin: '/home/me/.naby/../.claude/skills/review/SKILL.md',
          },
        }),
        { homeDir: '/home/me' },
      ),
    ).toEqual({ tier: 'tombstone', reason: 'outside-naby-home' });
  });

  it('a sibling directory that merely starts with the base name is refused', () => {
    expect(
      planHarnessDelete(
        row({ provenance: { source: 'external', origin: '/home/me/.naby-backup/skills/x.md' } }),
        { homeDir: '/home/me' },
      ),
    ).toEqual({ tier: 'tombstone', reason: 'outside-naby-home' });
  });

  it('never targets a content directory itself, however malformed the origin', () => {
    // `skills/SKILL.md` would resolve its "skill directory" to `skills/` — one
    // delete taking out every skill in the home.
    expect(
      planHarnessDelete(
        row({ provenance: { source: 'external', origin: '/home/me/.naby/skills/SKILL.md' } }),
        { homeDir: '/home/me' },
      ),
    ).toEqual({ tier: 'tombstone', reason: 'outside-naby-home' });
  });

  it('an org item is always a tombstone (no on-disk home)', () => {
    expect(
      planHarnessDelete(
        row({
          scope: 'org',
          scopeKey: 'default',
          provenance: { source: 'external', origin: '/home/me/.naby/skills/x/SKILL.md' },
        }),
        { homeDir: '/home/me' },
      ),
    ).toEqual({ tier: 'tombstone', reason: 'outside-naby-home' });
  });
});

describe('deleteHarnessSource — the containment re-check, on a real disk', () => {
  let home: string;
  let base: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'naby-src-'));
    base = join(home, '.naby');
    mkdirSync(join(base, 'skills'), { recursive: true });
    mkdirSync(join(base, 'commands'), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function plan(target: string, recursive: boolean) {
    return { tier: 'source' as const, target, recursive, base };
  }

  it('removes a skill directory whole', () => {
    const dir = join(base, 'skills', 'review');
    mkdirSync(dir);
    writeFileSync(join(dir, 'SKILL.md'), 'body');
    writeFileSync(join(dir, 'reference.md'), 'notes');

    expect(deleteHarnessSource(plan(dir, true))).toEqual({ outcome: 'deleted', target: dir });
    expect(existsSync(dir)).toBe(false);
  });

  it('removes a single command file and leaves its siblings', () => {
    const file = join(base, 'commands', 'ship.md');
    writeFileSync(file, 'Ship it.');
    writeFileSync(join(base, 'commands', 'keep.md'), 'Keep it.');

    expect(deleteHarnessSource(plan(file, false))).toEqual({ outcome: 'deleted', target: file });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(base, 'commands', 'keep.md'))).toBe(true);
  });

  it('reports `missing` when there is nothing there (already deleted by hand)', () => {
    const file = join(base, 'commands', 'ghost.md');
    expect(deleteHarnessSource(plan(file, false))).toEqual({ outcome: 'missing', target: file });
  });

  it('REFUSES a symlinked FILE whose real path escapes the harness home', () => {
    // The attack this check exists for: `~/.naby/commands/evil.md` is a link to a
    // file in `~/.claude`. Lexically it is inside the home; really it is not.
    const outside = join(home, '.claude', 'commands');
    mkdirSync(outside, { recursive: true });
    const victim = join(outside, 'real.md');
    writeFileSync(victim, 'the vendor file');
    const link = join(base, 'commands', 'evil.md');
    symlinkSync(victim, link);

    const res = deleteHarnessSource(plan(link, false));
    expect(res.outcome).toBe('refused');
    expect(existsSync(victim)).toBe(true);
    expect(readFileSync(victim, 'utf8')).toBe('the vendor file');
  });

  it('REFUSES a symlinked skill DIRECTORY whose real path escapes', () => {
    const outside = join(home, 'elsewhere', 'precious');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'SKILL.md'), 'not ours');
    const link = join(base, 'skills', 'linked');
    symlinkSync(outside, link);

    const res = deleteHarnessSource(plan(link, true));
    expect(res.outcome).toBe('refused');
    expect(existsSync(join(outside, 'SKILL.md'))).toBe(true);
  });

  it('REFUSES everything when the harness home itself does not exist', () => {
    const res = deleteHarnessSource({
      tier: 'source',
      target: join(home, 'nowhere', '.naby', 'commands', 'x.md'),
      recursive: false,
      base: join(home, 'nowhere', '.naby'),
    });
    expect(res.outcome).toBe('refused');
  });

  it('REFUSES a target that is not the kind of node the row described', () => {
    // The row says "skill directory", the disk says "file": the disk is not what
    // the row described, and guessing is not this function's job.
    const file = join(base, 'skills', 'weird');
    writeFileSync(file, 'a file where a directory was expected');
    const res = deleteHarnessSource(plan(file, true));
    expect(res.outcome).toBe('refused');
    expect(existsSync(file)).toBe(true);
  });

  it('a symlink INSIDE the home that resolves inside it is still fine', () => {
    // Containment is about the resolved location, not about links per se.
    const realDir = join(base, 'skills', 'real');
    mkdirSync(realDir);
    writeFileSync(join(realDir, 'SKILL.md'), 'body');
    const link = join(base, 'skills', 'alias');
    symlinkSync(realDir, link);

    expect(deleteHarnessSource(plan(link, true)).outcome).toBe('deleted');
    // The REAL directory is what went — deleting the link alone would have left
    // the skill on disk and the scan would re-import it.
    expect(existsSync(realDir)).toBe(false);
  });
});
