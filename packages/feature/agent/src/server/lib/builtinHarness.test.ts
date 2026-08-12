import { describe, it, expect } from 'vitest';
import {
  applyBuiltinHarnessActivation,
  ATLASSIAN_HARNESS_BUNDLE_ID,
  builtinHarnessAutoStatusKey,
  bundleOwning,
  BUILTIN_HARNESS_ASSETS,
  BUILTIN_HARNESS_BUNDLES,
  CIC_HARNESS_BUNDLE_ID,
  DEFAULT_USER_ID,
  MemoryStore,
  seedBuiltinHarness,
  type HarnessItem,
} from '../../../../../../../dist/naby-runtime.mjs';
import {
  ATLASSIAN_SERVER_NAME,
  CIC_SERVER_NAME,
  configuredHarnessBundles,
  findSystemMcpPreset,
} from './systemMcp';

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
const UPLOAD = 'confluence-upload';

describe('the built-in assets themselves', () => {
  it('ships the Confluence research pair and the upload skill', () => {
    expect(BUILTIN_HARNESS_ASSETS.map((a) => `${a.kind}:${a.name}`)).toEqual([
      `skill:${SKILL}`,
      `subagent:${SUBAGENT}`,
      `skill:${UPLOAD}`,
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

  it('gates the upload skill on run_command — the tool it does its work with', () => {
    // The opposite call from the research skill above, for the opposite reason:
    // this one RUNS a CLI, so a turn without a shell (an unprojected session has no
    // `run_command`) must not be handed 1.1k tokens of instructions for one.
    const upload = BUILTIN_HARNESS_ASSETS.find((a) => a.name === UPLOAD)!;
    expect(upload.toolRefs).toEqual(['run_command']);
    expect(upload.triggers).toContain('confluence');
    expect(upload.triggers).toContain('컨플루언스');
    // `업로드`/`upload` are deliberately NOT triggers: substring-matched they fire
    // on every "파일 업로드 API" turn in a product codebase (spike-harness-seed (h)).
    expect(upload.triggers).not.toContain('upload');
    expect(upload.triggers).not.toContain('업로드');
  });

  it('names each bundle from its own preset, so the save path needs no branch', () => {
    expect(findSystemMcpPreset(CIC_SERVER_NAME)!.harnessBundle).toBe(CIC_HARNESS_BUNDLE_ID);
    expect(BUILTIN_HARNESS_BUNDLES[CIC_HARNESS_BUNDLE_ID]).toEqual([SKILL, SUBAGENT]);
    // The upload skill hangs off ATLASSIAN, not cic: its three environment
    // variables are the three values that preset already collects, and a cic token
    // only proves the user can READ the index.
    expect(findSystemMcpPreset(ATLASSIAN_SERVER_NAME)!.harnessBundle).toBe(
      ATLASSIAN_HARNESS_BUNDLE_ID,
    );
    expect(BUILTIN_HARNESS_BUNDLES[ATLASSIAN_HARNESS_BUNDLE_ID]).toEqual([UPLOAD]);
  });

  it('keeps the bundles disjoint, and leaves skill-hub owning none', () => {
    expect(bundleOwning(UPLOAD)).toBe(ATLASSIAN_HARNESS_BUNDLE_ID);
    expect(bundleOwning(SKILL)).toBe(CIC_HARNESS_BUNDLE_ID);
    expect(bundleOwning('nothing-of-ours')).toBeUndefined();
    expect(findSystemMcpPreset('skill-hub')!.harnessBundle).toBeUndefined();
  });

  it('reports the configured presets bundle by bundle, for the boot seed', () => {
    const store = new MemoryStore();
    expect(configuredHarnessBundles(store)).toEqual([]);
    store.upsertMcpEntry({
      name: ATLASSIAN_SERVER_NAME,
      transport: 'stdio',
      command: '/usr/bin/true',
      args: ['mcp-atlassian'],
      status: 'enabled',
    });
    expect(configuredHarnessBundles(store)).toEqual([ATLASSIAN_HARNESS_BUNDLE_ID]);
    // A preset with no bundle contributes nothing, however it is configured.
    store.upsertMcpEntry({
      name: 'skill-hub',
      transport: 'http',
      url: 'https://example.invalid/mcp',
      status: 'enabled',
    });
    expect(configuredHarnessBundles(store)).toEqual([ATLASSIAN_HARNESS_BUNDLE_ID]);
  });
});

describe('seeding', () => {
  it('lands every item DISABLED — a skill with no server must not fire', () => {
    const store = new MemoryStore();
    const res = seedBuiltinHarness(store);
    expect(res.seeded).toEqual([SKILL, SUBAGENT, UPLOAD]);
    expect(rowFor(store, SKILL)!.status).toBe('disabled');
    expect(rowFor(store, SUBAGENT)!.status).toBe('disabled');
    expect(rowFor(store, UPLOAD)!.status).toBe('disabled');
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
    expect(again.kept).toEqual([SKILL, SUBAGENT, UPLOAD]);
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

  it('does not reach into the other bundle', () => {
    // The generalization's load-bearing property: one credential moves its own
    // items and nobody else's, so a user with cic but not atlassian gets research
    // without an upload skill that has no account to upload to.
    const store = seeded();
    const res = applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
    expect(res.changed).toEqual([SKILL, SUBAGENT]);
    expect(rowFor(store, UPLOAD)!.status).toBe('disabled');
  });
});

describe('the atlassian credential as the upload skill switch', () => {
  function seeded() {
    const store = new MemoryStore();
    seedBuiltinHarness(store);
    return store;
  }

  it('enables only the upload skill when the credential is saved', () => {
    const store = seeded();
    const res = applyBuiltinHarnessActivation(store, ATLASSIAN_HARNESS_BUNDLE_ID, true);
    expect(res.changed).toEqual([UPLOAD]);
    expect(rowFor(store, UPLOAD)!.status).toBe('enabled');
    expect(rowFor(store, SKILL)!.status).toBe('disabled');
    expect(rowFor(store, SUBAGENT)!.status).toBe('disabled');
  });

  it('disables it again when the preset is removed', () => {
    const store = seeded();
    applyBuiltinHarnessActivation(store, ATLASSIAN_HARNESS_BUNDLE_ID, true);
    const res = applyBuiltinHarnessActivation(store, ATLASSIAN_HARNESS_BUNDLE_ID, false);
    expect(res.changed).toEqual([UPLOAD]);
    expect(rowFor(store, UPLOAD)!.status).toBe('disabled');
  });

  it('KEEPS OFF WHAT THE USER TURNED OFF, through a re-save', () => {
    const store = seeded();
    applyBuiltinHarnessActivation(store, ATLASSIAN_HARNESS_BUNDLE_ID, true);
    store.setHarnessEnabled(rowFor(store, UPLOAD)!.id, false);
    const res = applyBuiltinHarnessActivation(store, ATLASSIAN_HARNESS_BUNDLE_ID, true);
    expect(res.userOwned).toEqual([UPLOAD]);
    expect(res.changed).toEqual([]);
    expect(rowFor(store, UPLOAD)!.status).toBe('disabled');
  });
});

describe('seeding a bundle whose server is ALREADY configured', () => {
  /**
   * The hole the save/remove switch cannot cover.
   *
   * The atlassian preset has existed since 0.2.0; `confluence-upload` ships now. An
   * existing user saved that credential long ago and has no reason to save it again,
   * so the switch never fires for them and the row would sit disabled forever —
   * a shipped feature nobody is told to turn on. The boot seed answers it instead,
   * by asking the registry which presets are configured.
   */
  it('arrives ENABLED for a user who configured the preset before the skill existed', () => {
    const store = new MemoryStore();
    store.upsertMcpEntry({
      name: ATLASSIAN_SERVER_NAME,
      transport: 'stdio',
      command: '/usr/bin/true',
      args: ['mcp-atlassian'],
      status: 'enabled',
    });
    seedBuiltinHarness(store, { activeBundles: configuredHarnessBundles(store) });
    expect(rowFor(store, UPLOAD)!.status).toBe('enabled');
    // ...and only that one. cic is not configured here.
    expect(rowFor(store, SKILL)!.status).toBe('disabled');
    expect(rowFor(store, SUBAGENT)!.status).toBe('disabled');
  });

  it('records what it wrote, so the user can still take ownership afterwards', () => {
    const store = new MemoryStore();
    seedBuiltinHarness(store, { activeBundles: [ATLASSIAN_HARNESS_BUNDLE_ID] });
    expect(store.getSetting(builtinHarnessAutoStatusKey(UPLOAD))).toBe('enabled');
    // Turned off by hand, it stays off through a later save — the same rule as a
    // row that was switched on rather than seeded on.
    store.setHarnessEnabled(rowFor(store, UPLOAD)!.id, false);
    const res = applyBuiltinHarnessActivation(store, ATLASSIAN_HARNESS_BUNDLE_ID, true);
    expect(res.userOwned).toEqual([UPLOAD]);
    expect(rowFor(store, UPLOAD)!.status).toBe('disabled');
  });

  it('changes nothing for a user with no System MCP configured at all', () => {
    const store = new MemoryStore();
    seedBuiltinHarness(store, { activeBundles: configuredHarnessBundles(store) });
    for (const name of [SKILL, SUBAGENT, UPLOAD]) {
      expect(rowFor(store, name)!.status).toBe('disabled');
      expect(store.getSetting(builtinHarnessAutoStatusKey(name))).toBe('disabled');
    }
  });

  it('cannot enable a row that already exists — seeding only ever adds', () => {
    // The guard that keeps this from being a back door into "boot re-enables what
    // the user disabled": the active-bundle branch is below the already-seeded
    // check, so it is unreachable for any row that is already there.
    const store = new MemoryStore();
    seedBuiltinHarness(store);
    store.upsertMcpEntry({
      name: ATLASSIAN_SERVER_NAME,
      transport: 'stdio',
      command: '/usr/bin/true',
      args: ['mcp-atlassian'],
      status: 'enabled',
    });
    const again = seedBuiltinHarness(store, { activeBundles: configuredHarnessBundles(store) });
    expect(again.seeded).toEqual([]);
    expect(rowFor(store, UPLOAD)!.status).toBe('disabled');
  });
});
