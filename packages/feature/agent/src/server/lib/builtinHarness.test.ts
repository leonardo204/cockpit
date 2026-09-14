import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALWAYS_ON_HARNESS_BUNDLES,
  applyBuiltinHarnessActivation,
  ATLASSIAN_HARNESS_BUNDLE_ID,
  builtinHarnessAutoStatusKey,
  bundleOwning,
  BUILTIN_HARNESS_ASSETS,
  BUILTIN_HARNESS_BUNDLES,
  CIC_HARNESS_BUNDLE_ID,
  CORE_HARNESS_BUNDLE_ID,
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
 * THE BUILT-IN HARNESS BUNDLES AND THEIR SWITCHES (skill-hub-builtin §2.7,
 * subagent-delegation §4.1).
 *
 * Two KINDS of bundle now ship, and the difference is what turns them on.
 *
 * A CREDENTIAL-SWITCHED BUNDLE. The `confluence-context` skill and the
 * `confluence-researcher` subagent are useless, worse than useless, without the
 * `cic` server: the subagent's only tools are `cic__*`, so with no credential it
 * answers every delegation with its own failure. So the credential is the switch.
 *
 * AN ALWAYS-ON BUNDLE. `core` — `explorer` and `implementer` — has no System MCP
 * preset behind it and never will: they run on the backend's own tools, so there
 * is no credential whose arrival could switch them on. `ALWAYS_ON_HARNESS_BUNDLES`
 * is how they arrive enabled instead, spread into the boot seed's `activeBundles`
 * alongside the configured presets. The distinction the tests below hold onto is
 * that this is still a SEED-TIME default: `configuredHarnessBundles` must not
 * learn about `core` (§2.7.2 — it reads the MCP registry and nothing else), and a
 * row the user disables stays disabled through every later boot.
 *
 * The cases that matter most are the USER-OWNERSHIP ones — the skill turned off by
 * hand that must still be off after the token is re-saved, and the `explorer`
 * disabled once that must still be disabled on the next boot. An automatic switch
 * that can undo a person's explicit choice makes the choice meaningless, and those
 * are the regressions that would reintroduce it.
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
const EXPLORER = 'explorer';
const IMPLEMENTER = 'implementer';

/** Every built-in, in the order the generated table lists them — which is the
 *  order `seeded` and `kept` come back in. */
const ALL_ASSETS = [SKILL, SUBAGENT, UPLOAD, EXPLORER, IMPLEMENTER];

describe('the built-in assets themselves', () => {
  it('ships the Confluence research pair, the upload skill and the two core delegates', () => {
    expect(BUILTIN_HARNESS_ASSETS.map((a) => `${a.kind}:${a.name}`)).toEqual([
      `skill:${SKILL}`,
      `subagent:${SUBAGENT}`,
      `skill:${UPLOAD}`,
      // subagent-delegation §4.1: the `core` bundle, appended AFTER the existing
      // three. Order matters to this suite only because `seeded`/`kept` follow it.
      `subagent:${EXPLORER}`,
      `subagent:${IMPLEMENTER}`,
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
    // No `activeBundles` at all: nothing is claimed to be configured, so nothing
    // arrives on — INCLUDING the `core` pair, whose "always on" lives in the boot
    // call site's spread and not in the seed itself.
    const res = seedBuiltinHarness(store);
    expect(res.seeded).toEqual(ALL_ASSETS);
    for (const name of ALL_ASSETS) {
      expect(rowFor(store, name)!.status, name).toBe('disabled');
    }
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
    expect(again.kept).toEqual(ALL_ASSETS);
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

describe('the always-on `core` bundle (subagent-delegation §4.1)', () => {
  it('names itself in the runtime list, and owns exactly the two delegates', () => {
    expect(ALWAYS_ON_HARNESS_BUNDLES).toEqual([CORE_HARNESS_BUNDLE_ID]);
    expect(BUILTIN_HARNESS_BUNDLES[CORE_HARNESS_BUNDLE_ID]).toEqual([EXPLORER, IMPLEMENTER]);
    expect(bundleOwning(EXPLORER)).toBe(CORE_HARNESS_BUNDLE_ID);
    expect(bundleOwning(IMPLEMENTER)).toBe(CORE_HARNESS_BUNDLE_ID);
  });

  it('arrives ENABLED when the boot spread is applied, and only those two', () => {
    const store = new MemoryStore();
    seedBuiltinHarness(store, { activeBundles: [...ALWAYS_ON_HARNESS_BUNDLES] });
    expect(rowFor(store, EXPLORER)!.status).toBe('enabled');
    expect(rowFor(store, IMPLEMENTER)!.status).toBe('enabled');
    // The credential-switched bundles are untouched by it: `core` being on says
    // nothing about whether a Confluence token exists.
    for (const name of [SKILL, SUBAGENT, UPLOAD]) {
      expect(rowFor(store, name)!.status, name).toBe('disabled');
    }
  });

  it('carries the artifacts into the rows — haiku with the read tools, sonnet with none', () => {
    // The models are the REASON these two exist (§2 principle 1): a delegation
    // that runs on the main model saves the transcript but not the money, and an
    // explorer that inherits opus is the expensive case wearing a cheap name.
    const store = new MemoryStore();
    seedBuiltinHarness(store, { activeBundles: [...ALWAYS_ON_HARNESS_BUNDLES] });
    const explorer = rowFor(store, EXPLORER)!;
    expect(explorer.subagent?.model).toBe('haiku');
    expect(explorer.subagent?.toolRefs).toEqual(['Read', 'Glob', 'Grep']);
    // dev-claude ONLY — the filter `gatherSubagents` applies (see
    // engines/nabySubagentDelegation.test.ts) reads exactly this field.
    expect(explorer.subagent?.engines).toEqual(['dev-claude']);
    const implementer = rowFor(store, IMPLEMENTER)!;
    expect(implementer.subagent?.model).toBe('sonnet');
    // Deliberately unrestricted: the edit/exec tools differ per turn, and the gate
    // — not a frozen list — is what decides whether a change may happen (§4.1).
    expect(implementer.subagent?.toolRefs).toBeUndefined();
    expect(implementer.subagent?.engines).toEqual(['dev-claude']);
  });

  it('stays disabled on the next boot once the user turns it off', () => {
    // "Always on" is the DEFAULT it arrives with, not a value re-asserted every
    // boot. This is the regression that would make the setting meaningless.
    const store = new MemoryStore();
    seedBuiltinHarness(store, { activeBundles: [...ALWAYS_ON_HARNESS_BUNDLES] });
    store.setHarnessEnabled(rowFor(store, EXPLORER)!.id, false);
    const again = seedBuiltinHarness(store, { activeBundles: [...ALWAYS_ON_HARNESS_BUNDLES] });
    expect(again.seeded).toEqual([]);
    expect(rowFor(store, EXPLORER)!.status).toBe('disabled');
  });

  it('is not something the MCP registry can report — `core` has no preset', () => {
    // §2.7.2: the preset walk stays a pure reading of the registry. If `core` ever
    // appeared here, the always-on list and the preset table would both claim to
    // own the bundle and a disagreement between them would be silent.
    const store = new MemoryStore();
    expect(configuredHarnessBundles(store)).not.toContain(CORE_HARNESS_BUNDLE_ID);
    store.upsertMcpEntry({
      name: ATLASSIAN_SERVER_NAME,
      transport: 'stdio',
      command: '/usr/bin/true',
      args: ['mcp-atlassian'],
      status: 'enabled',
    });
    store.upsertMcpEntry({
      name: CIC_SERVER_NAME,
      transport: 'stdio',
      command: '/usr/bin/true',
      args: ['cic-mcp'],
      status: 'enabled',
    });
    // Every bundle it reports is a bundle some preset names, in preset order.
    expect(configuredHarnessBundles(store)).toEqual([
      ATLASSIAN_HARNESS_BUNDLE_ID,
      CIC_HARNESS_BUNDLE_ID,
    ]);
    expect(configuredHarnessBundles(store)).not.toContain(CORE_HARNESS_BUNDLE_ID);
  });

  it('is spread into the boot seed at the one call site that seeds', () => {
    // A SOURCE ASSERTION, because the call site is inside `getStore()`'s
    // once-per-process init: reaching it from a test means opening a real database
    // for the process and never being able to open a second one. What matters is
    // the SHAPE of the argument — the configured presets plus the always-on list —
    // and dropping the spread is a silent failure (the two rows seed disabled and
    // nothing ever turns them on, because no credential belongs to them).
    const src = readFileSync(join(__dirname, '..', 'engines', 'naby.ts'), 'utf8');
    expect(src).toContain(
      'activeBundles: [...configuredHarnessBundles(sharedStore), ...ALWAYS_ON_HARNESS_BUNDLES],',
    );
    // And the shell does NOT keep its own copy of the list — the bundle id is
    // spread from the runtime constant, never spelled out at the call site.
    expect(src).toContain('ALWAYS_ON_HARNESS_BUNDLES,');
    expect(src).not.toContain("activeBundles: ['core'");
  });
});
