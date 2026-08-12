import { describe, it, expect } from 'vitest';
import {
  applyBuiltinHarnessActivation,
  builtinHarnessAutoStatusKey,
  BUILTIN_HARNESS_ASSETS,
  BUILTIN_HARNESS_BUNDLES,
  CIC_HARNESS_BUNDLE_ID,
  DEFAULT_USER_ID,
  MemoryStore,
  seedBuiltinHarness,
  type HarnessItem,
} from '../../../../../../../dist/naby-runtime.mjs';
import { CIC_SERVER_NAME, findSystemMcpPreset } from './systemMcp';

/**
 * THE BUILT-IN HARNESS BUNDLE AND ITS ONE SWITCH (skill-hub-builtin §2.7).
 *
 * Two things ship with naby — the `confluence-context` skill and the
 * `confluence-researcher` subagent — and they are useless, worse than useless,
 * without the `cic` server: the subagent's only tools are `cic__*`, so with no
 * credential it answers every delegation with its own failure. So the credential is
 * the switch.
 *
 * The case that matters most here is the LAST one: a user who turns the skill off
 * by hand must find it still off after re-saving the token. An automatic switch
 * that can undo a person's explicit choice makes the choice meaningless, and this
 * is the regression that would reintroduce it.
 *
 * Run against the REAL store (MemoryStore), not a fake, because the interesting
 * behaviour lives in the import gate and in `setHarnessEnabled` — a fake would be
 * asserting the test's own idea of those.
 */

function rowFor(store: MemoryStore, name: string): HarnessItem | undefined {
  const asset = BUILTIN_HARNESS_ASSETS.find((a) => a.name === name)!;
  return store
    .listHarness('user', DEFAULT_USER_ID, { kind: asset.kind })
    .find((r) => r.name === name);
}

const SKILL = 'confluence-context';
const SUBAGENT = 'confluence-researcher';

describe('the built-in assets themselves', () => {
  it('ships exactly the Confluence pair, as a skill and a subagent', () => {
    expect(BUILTIN_HARNESS_ASSETS.map((a) => `${a.kind}:${a.name}`)).toEqual([
      `skill:${SKILL}`,
      `subagent:${SUBAGENT}`,
    ]);
  });

  it('keeps the subagent restricted to the cic tools, in the spelling its file uses', () => {
    const agent = BUILTIN_HARNESS_ASSETS.find((a) => a.name === SUBAGENT)!;
    expect(agent.toolRefs).toEqual([
      'mcp__cic__find_docs',
      'mcp__cic__read_section',
      'mcp__cic__search_cql',
      'mcp__cic__read_page',
    ]);
  });

  it('leaves the skill without toolRefs, so injection never waits on a tool', () => {
    // skill-inject.ts excludes a skill whose toolRefs are not all present. The
    // skill decides WHETHER to research and delegates the doing, so gating its
    // instructions on a tool it never calls would silence it for no reason.
    const skill = BUILTIN_HARNESS_ASSETS.find((a) => a.name === SKILL)!;
    expect(skill.toolRefs).toBeUndefined();
  });

  it('names the cic bundle from the preset, so the save path needs no branch', () => {
    const preset = findSystemMcpPreset(CIC_SERVER_NAME)!;
    expect(preset.harnessBundle).toBe(CIC_HARNESS_BUNDLE_ID);
    expect(BUILTIN_HARNESS_BUNDLES[CIC_HARNESS_BUNDLE_ID]).toEqual([SKILL, SUBAGENT]);
  });

  it('is the ONLY preset that owns a bundle — the others switch nothing on', () => {
    const owners = [...(BUILTIN_HARNESS_BUNDLES[CIC_HARNESS_BUNDLE_ID] ?? [])];
    expect(owners.length).toBeGreaterThan(0);
    for (const name of ['skill-hub', 'atlassian']) {
      expect(findSystemMcpPreset(name)!.harnessBundle).toBeUndefined();
    }
  });
});

describe('seeding', () => {
  it('lands both items DISABLED — a skill that cannot research must not fire', () => {
    const store = new MemoryStore();
    const res = seedBuiltinHarness(store);
    expect(res.seeded).toEqual([SKILL, SUBAGENT]);
    expect(rowFor(store, SKILL)!.status).toBe('disabled');
    expect(rowFor(store, SUBAGENT)!.status).toBe('disabled');
  });

  it('carries the artifact into the row: body without frontmatter, model, tools', () => {
    const store = new MemoryStore();
    seedBuiltinHarness(store);
    const skill = rowFor(store, SKILL)!;
    expect(skill.skill?.instructions.startsWith('---')).toBe(false);
    expect(skill.skill?.instructions).toContain('# confluence-context');
    const agent = rowFor(store, SUBAGENT)!;
    expect(agent.subagent?.model).toBe('opus');
    expect(agent.subagent?.toolRefs).toContain('mcp__cic__find_docs');
    expect(agent.description).toContain('Confluence');
  });

  it('is idempotent — a second boot seeds nothing and rewrites nothing', () => {
    const store = new MemoryStore();
    seedBuiltinHarness(store);
    const before = rowFor(store, SKILL)!;
    const again = seedBuiltinHarness(store);
    expect(again.seeded).toEqual([]);
    expect(again.kept).toEqual([SKILL, SUBAGENT]);
    expect(rowFor(store, SKILL)!.id).toBe(before.id);
    expect(rowFor(store, SKILL)!.updatedAt).toBe(before.updatedAt);
  });

  it('never rewrites an item the user edited', () => {
    const store = new MemoryStore();
    seedBuiltinHarness(store);
    const row = rowFor(store, SKILL)!;
    store.putHarnessItem({
      item: {
        scope: 'user',
        scopeKey: DEFAULT_USER_ID,
        kind: 'skill',
        name: SKILL,
        provenance: { source: 'user' },
        skill: { instructions: 'my own version' },
      },
      requestedStatus: 'enabled',
    });
    seedBuiltinHarness(store);
    expect(rowFor(store, SKILL)!.skill?.instructions).toBe('my own version');
    expect(rowFor(store, SKILL)!.id).toBe(row.id);
  });

  it('does not resurrect an item the user deleted', () => {
    const store = new MemoryStore();
    seedBuiltinHarness(store);
    // A built-in has no file, so the delete tier tombstones it (harnessSource.ts).
    store.setHarnessStatus(rowFor(store, SKILL)!.id, 'removed');
    const again = seedBuiltinHarness(store);
    expect(again.seeded).toEqual([]);
    expect(rowFor(store, SKILL)!.status).toBe('removed');
  });
});

describe('the cic credential as the switch', () => {
  function seeded() {
    const store = new MemoryStore();
    seedBuiltinHarness(store);
    return store;
  }

  it('enables both when the token is saved', () => {
    const store = seeded();
    const res = applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
    expect(res.changed).toEqual([SKILL, SUBAGENT]);
    expect(rowFor(store, SKILL)!.status).toBe('enabled');
    expect(rowFor(store, SUBAGENT)!.status).toBe('enabled');
  });

  it('disables both when the preset is removed', () => {
    const store = seeded();
    applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
    const res = applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, false);
    expect(res.changed).toEqual([SKILL, SUBAGENT]);
    expect(rowFor(store, SKILL)!.status).toBe('disabled');
    expect(rowFor(store, SUBAGENT)!.status).toBe('disabled');
  });

  it('is idempotent — a second save of the same token changes nothing', () => {
    const store = seeded();
    applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
    const res = applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
    expect(res.changed).toEqual([]);
    expect(rowFor(store, SKILL)!.status).toBe('enabled');
  });

  it('KEEPS OFF WHAT THE USER TURNED OFF, through a re-save of the token', () => {
    // The core regression. Connect, let both come alive, then turn the skill off by
    // hand — the way a user does when a skill is firing more than they want.
    const store = seeded();
    applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
    store.setHarnessEnabled(rowFor(store, SKILL)!.id, false);

    // Re-saving the credential (a new token, an edit, a reconnect) must not undo it.
    const res = applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
    expect(res.userOwned).toEqual([SKILL]);
    expect(res.changed).toEqual([]);
    expect(rowFor(store, SKILL)!.status).toBe('disabled');
    // ...and the half the user did NOT touch is still on.
    expect(rowFor(store, SUBAGENT)!.status).toBe('enabled');

    // Still theirs after a disconnect/reconnect cycle, not just the once.
    applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, false);
    applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
    expect(rowFor(store, SKILL)!.status).toBe('disabled');
  });

  it('leaves alone an item the user enabled BEFORE any credential existed', () => {
    const store = seeded();
    store.setHarnessEnabled(rowFor(store, SUBAGENT)!.id, true);
    const off = applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, false);
    expect(off.userOwned).toContain(SUBAGENT);
    expect(rowFor(store, SUBAGENT)!.status).toBe('enabled');
  });

  it('never resurrects a tombstone', () => {
    const store = seeded();
    store.setHarnessStatus(rowFor(store, SKILL)!.id, 'removed');
    const res = applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
    expect(res.userOwned).toContain(SKILL);
    expect(rowFor(store, SKILL)!.status).toBe('removed');
  });

  it('reports rows that were never seeded rather than creating them', () => {
    const store = new MemoryStore();
    const res = applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
    expect(res.missing).toEqual([SKILL, SUBAGENT]);
    expect(res.changed).toEqual([]);
  });

  it('treats a missing auto-status record as the disabled the seed always wrote', () => {
    // Rows seeded by a build before the record existed must still switch on once.
    const store = seeded();
    store.setSetting(builtinHarnessAutoStatusKey(SKILL), '');
    const res = applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
    expect(res.changed).toContain(SKILL);
  });

  it('does nothing for a bundle nobody declares', () => {
    const store = seeded();
    const res = applyBuiltinHarnessActivation(store, 'no-such-bundle', true);
    expect(res).toEqual({ changed: [], userOwned: [], missing: [] });
    expect(rowFor(store, SKILL)!.status).toBe('disabled');
  });
});
