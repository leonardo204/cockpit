import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNabyState, runNabyAction } from './naby';
import { getStore } from '../engines/naby';
import {
  ATLASSIAN_PACKAGE,
  ATLASSIAN_SERVER_NAME,
  ATLASSIAN_URL_KEY,
  DEFAULT_CONFLUENCE_URL,
  DEFAULT_SKILL_HUB_URL,
  SKILL_HUB_SERVER_NAME,
  SKILL_HUB_URL_KEY,
  SYSTEM_MCP_PRESET_NAMES,
} from '../lib/systemMcp';
import { commandPathEnvVar } from '../lib/commandPath';
import {
  BUILTIN_PERSONA_ID,
  DEFAULT_USER_ID,
  REFLECTION_IDLE_MS,
} from '../../../../../../../dist/naby-runtime.mjs';
import { AUTONOMY_STEP_CAP } from '../lib/autonomy';
import {
  resetBotCommandRegistration,
  stopTelegramListener,
  telegramListenerRunning,
} from '../lib/telegramEscalation';

/**
 * `reflection.run` — the on-demand entry point to the session-reflection sweep
 * (P3-M8a/M8b, spec §4.3). The sweep itself is covered in lib/reflection.test.ts
 * with an injected judge; this covers the WIRING: that the action exists, reaches
 * the same store the engine writes, and answers with the full set of counts —
 * both the ledger half and (M8b) the memory half.
 *
 * It runs against the throwaway database vitest.setup.ts points NABY_DB_PATH at,
 * never the developer's ~/.naby/app.db.
 */
describe('POST /api/naby — reflection.run', () => {
  it('answers with the sweep counts', async () => {
    const result = await runNabyAction({ action: 'reflection.run' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reflection).toBeDefined();
    expect(typeof result.reflection?.sweptSessions).toBe('number');
    expect(typeof result.reflection?.markedEvents).toBe('number');
    expect(typeof result.reflection?.droppedVerdicts).toBe('number');
    // P3-M8b: the memory half is reported too, and reads zero on a run with no
    // idle session to reflect on rather than being absent.
    expect(result.reflection?.proposedMemories).toBe(0);
    expect(result.reflection?.droppedCandidates).toBe(0);
    expect(result.reflection?.autoConfirmed).toBe(0);
  });

  it('runs against the same store the engine writes, and leaves a live session alone', async () => {
    const store = getStore();
    const sessionId = `reflection-action-${Date.now()}`;
    store.touchSession(sessionId, 'test-provider');
    store.appendMessage(sessionId, { role: 'user', content: 'hello' });
    store.appendMessage(sessionId, { role: 'assistant', content: 'hi' });
    expect(store.getReflectionCursor(sessionId)).toBeUndefined();

    const result = await runNabyAction({ action: 'reflection.run' });
    expect(result.ok).toBe(true);

    // The session was touched a moment ago, so it is not yet idle: the due-ness
    // rule (§4.2) holds at the API boundary too, and no cursor was written. This
    // also means no model call was made — the action is safe with no credentials.
    expect(store.getReflectionCursor(sessionId)).toBeUndefined();

    // The cursor round-trips through the same store the action reads.
    const at = Date.now() - REFLECTION_IDLE_MS;
    store.setReflectionCursor(sessionId, 1, at);
    expect(store.getReflectionCursor(sessionId)).toEqual({ lastSeq: 1, reflectedAt: at });
  });

  it('an unexcluded live session id is accepted as a parameter', async () => {
    const result = await runNabyAction({ action: 'reflection.run', excludeSessionId: 'no-such-session' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reflection?.sweptSessions).toBeGreaterThanOrEqual(0);
  });
});

/**
 * `agent.put` and the BUILT-IN PERSONA (user decision, 2026-07-30 — it replaces
 * M1's "editable but undeletable").
 *
 * The persona's system prompt IS the contract every later milestone builds on:
 * memory injection, escalation, the autonomy budget, and everything the trust
 * meter scores. A user who edited it got an agent that behaved unlike the one
 * being measured, with no way back — the row refuses to be deleted. So it is now
 * read-only, and this route is one of the two places that says so (the store is
 * the other, and it THROWS; this one answers with a sentence a panel can show).
 */
describe('POST /api/naby — agent.put refuses the built-in persona', () => {
  it('refuses an edit addressed to the well-known persona id', async () => {
    const store = getStore();
    const before = store.getAgent(BUILTIN_PERSONA_ID);
    expect(before, 'the persona is seeded by the engine composition root').toBeDefined();

    const result = await runNabyAction({
      action: 'agent.put',
      id: BUILTIN_PERSONA_ID,
      name: 'aria',
      systemPrompt: 'you are something else now',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/read-only/i);

    // NOT MERELY REPORTED AS REFUSED — nothing was written.
    const after = store.getAgent(BUILTIN_PERSONA_ID);
    expect(after?.systemPrompt).toBe(before?.systemPrompt);
    expect(after?.name).toBe(before?.name);
    expect(store.getAgentByName('aria')).toBeUndefined();
  });

  it('refuses a request that asks for kind=persona, so no second persona is minted', async () => {
    const store = getStore();
    const personasBefore = store.listAgents().filter((a) => a.kind === 'persona').length;

    const result = await runNabyAction({
      action: 'agent.put',
      name: `impostor-${Date.now()}`,
      kind: 'persona',
      systemPrompt: 'me too',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/read-only/i);
    expect(store.listAgents().filter((a) => a.kind === 'persona')).toHaveLength(personasBefore);
  });

  it('still writes ordinary custom agents, and always as kind=custom', async () => {
    // The guard must not have made the route useless: the panel's real job is
    // custom agents, and they are unaffected.
    const store = getStore();
    const name = `scout-${Date.now()}`;
    const result = await runNabyAction({
      action: 'agent.put',
      name,
      systemPrompt: 'scout the repo',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent?.name).toBe(name);
    expect(result.agent?.kind).toBe('custom');

    // And editing THAT agent still works — the refusal keys on the persona, not
    // on the presence of an id.
    const edited = await runNabyAction({
      action: 'agent.put',
      id: result.agent!.id,
      name,
      systemPrompt: 'scout the repo, quietly',
    });
    expect(edited.ok).toBe(true);
    expect(store.getAgent(result.agent!.id)?.systemPrompt).toBe('scout the repo, quietly');

    store.removeAgent(result.agent!.id);
  });
});

/**
 * `growth.get` — the trust reading, plus (P3-M8c, spec §6.3) the LEARNING block
 * beside it. The computation is covered in lib/learningRead.test.ts; this covers
 * the wiring and the ONE structural promise the panel depends on: the two are
 * separate fields, so no learning count can reach the butterfly reading.
 */
describe('POST /api/naby — growth.get and the learning block', () => {
  it('answers with the growth reading and a learning block beside it', async () => {
    const result = await runNabyAction({ action: 'growth.get' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.growth).toBeDefined();
    expect(result.learning).toBeDefined();
    expect(typeof result.learning?.confirmedTotal).toBe('number');
    expect(typeof result.learning?.proposedCount).toBe('number');
    expect(typeof result.learning?.corroborated2Plus).toBe('number');
    expect(typeof result.learning?.distinctTaskTypes).toBe('number');
    expect(typeof result.learning?.confirmedByScope.user).toBe('number');
  });

  it('keeps the learning counts OUT of the growth reading (§6.3)', async () => {
    // The separation is the load-bearing part. butterfly-trust-meter §2 decided
    // that counting stored facts is not a trust signal, and §9.2 rule 2 says two
    // numbers on one screen must never disagree; the only durable way to keep
    // that true is for the meter's shape not to contain these fields at all.
    const result = await runNabyAction({ action: 'growth.get' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const growth = result.growth as unknown as Record<string, unknown>;
    for (const key of ['confirmedTotal', 'proposedCount', 'corroborated2Plus', 'learning']) {
      expect(growth, `growth must not carry ${key}`).not.toHaveProperty(key);
    }
  });

  it('counts real confirmed memory, and moves when a proposal is confirmed', async () => {
    const store = getStore();
    const key = `panel-fact-${Date.now()}`;
    const before = await runNabyAction({ action: 'growth.get' });
    if (!before.ok) throw new Error('growth.get failed');
    const confirmedBefore = before.learning!.confirmedTotal;
    const proposedBefore = before.learning!.proposedCount;

    const row = store.putMemory({
      scope: 'user',
      scopeKey: DEFAULT_USER_ID,
      type: 'semantic',
      key,
      value: 'Wants the SQL before the explanation.',
      provenance: { source: 'artifact', sessionId: 'sess-panel' },
      confidence: 0.5,
      requestedStatus: 'proposed',
    });

    const proposed = await runNabyAction({ action: 'growth.get' });
    if (!proposed.ok) throw new Error('growth.get failed');
    // A PROPOSAL IS NOT A FACT IN USE: it cannot shape a turn until confirmed,
    // so it must move the review count and not the confirmed one.
    expect(proposed.learning!.proposedCount).toBe(proposedBefore + 1);
    expect(proposed.learning!.confirmedTotal).toBe(confirmedBefore);

    store.confirmMemory(row.id);
    const after = await runNabyAction({ action: 'growth.get' });
    if (!after.ok) throw new Error('growth.get failed');
    expect(after.learning!.confirmedTotal).toBe(confirmedBefore + 1);
    expect(after.learning!.proposedCount).toBe(proposedBefore);
  });

  it('counts project-scope memory only when a cwd is supplied', async () => {
    const store = getStore();
    const cwd = `/tmp/naby-panel-${Date.now()}`;
    store.putMemory({
      scope: 'project',
      scopeKey: cwd,
      type: 'procedural',
      key: 'build-command',
      value: 'Builds with npm run build:app before packaging.',
      provenance: { source: 'user' },
      confidence: 1,
      requestedStatus: 'confirmed',
    });

    const without = await runNabyAction({ action: 'growth.get' });
    if (!without.ok) throw new Error('growth.get failed');
    // Absent, not zero: with no project open there is no project to report on.
    expect(without.learning!.confirmedByScope.project).toBeUndefined();

    const withCwd = await runNabyAction({ action: 'growth.get', cwd });
    if (!withCwd.ok) throw new Error('growth.get failed');
    expect(withCwd.learning!.confirmedByScope.project).toBe(1);
    expect(withCwd.learning!.confirmedTotal).toBe(without.learning!.confirmedTotal + 1);
  });

  it('reports the last reflection time from the cursors', async () => {
    const store = getStore();
    const sessionId = `growth-reflected-${Date.now()}`;
    store.touchSession(sessionId, 'test-provider');
    const at = Date.now();
    store.setReflectionCursor(sessionId, 3, at);

    const result = await runNabyAction({ action: 'growth.get', agentId: BUILTIN_PERSONA_ID });
    if (!result.ok) throw new Error('growth.get failed');
    expect(result.learning!.lastReflectionAt).toBeGreaterThanOrEqual(at);
  });
});

/**
 * `personaAutonomy.get` / `.set` — the persona's DELEGATION settings (P3-M9, G1).
 *
 * The rules (defaults, clamp, per-field writes) are unit-tested against a fake
 * store in lib/personaAutonomy.test.ts. What is tested HERE is the wiring: that
 * the actions exist, validate what came off the wire, and land in the same store
 * the engine reads for a persona turn — which is the whole point of moving the
 * setting off the read-only agent row.
 */
describe('POST /api/naby — personaAutonomy', () => {
  it('reads the defaults on an install that has never chosen', async () => {
    const result = await runNabyAction({ action: 'personaAutonomy.get' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.personaAutonomy).toEqual({ escalation: 'inline', maxSteps: 1 });
    // The ceiling ships with the settings so the UI can STATE the limit rather
    // than letting the user discover it by typing 50.
    expect(result.autonomyStepCap).toBe(AUTONOMY_STEP_CAP);
  });

  it('round-trips through the same store the engine reads', async () => {
    const saved = await runNabyAction({
      action: 'personaAutonomy.set',
      escalation: 'both',
      maxSteps: 6,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.personaAutonomy).toEqual({ escalation: 'both', maxSteps: 6 });

    // Read back through the store the engine uses, not through the action, so
    // this cannot pass on an in-memory echo.
    expect(getStore().getSetting('persona.autonomy.escalation')).toBe('both');
    expect(getStore().getSetting('persona.autonomy.maxSteps')).toBe('6');

    const read = await runNabyAction({ action: 'personaAutonomy.get' });
    if (!read.ok) return;
    expect(read.personaAutonomy).toEqual({ escalation: 'both', maxSteps: 6 });
  });

  it('answers with the CLAMPED value, so the panel shows what will actually run', async () => {
    const result = await runNabyAction({ action: 'personaAutonomy.set', maxSteps: 999 });
    if (!result.ok) throw new Error('personaAutonomy.set failed');
    expect(result.personaAutonomy!.maxSteps).toBe(AUTONOMY_STEP_CAP);
    expect(getStore().getSetting('persona.autonomy.maxSteps')).toBe(String(AUTONOMY_STEP_CAP));
  });

  it('leaves the other field alone on a one-field save', async () => {
    await runNabyAction({ action: 'personaAutonomy.set', escalation: 'inline', maxSteps: 3 });
    const result = await runNabyAction({ action: 'personaAutonomy.set', escalation: 'telegram' });
    if (!result.ok) throw new Error('personaAutonomy.set failed');
    expect(result.personaAutonomy).toEqual({ escalation: 'telegram', maxSteps: 3 });
  });

  it('refuses an unusable value rather than quietly coercing it', async () => {
    // A UI bug should surface as an error the user can report, not as a setting
    // that silently became something else.
    const bad = await runNabyAction({
      action: 'personaAutonomy.set',
      escalation: 'carrier-pigeon',
    });
    expect(bad.ok).toBe(false);
    const badSteps = await runNabyAction({
      action: 'personaAutonomy.set',
      maxSteps: Number.NaN,
    });
    expect(badSteps.ok).toBe(false);
  });

  it('never touches the read-only persona row', async () => {
    const before = getStore().getAgent(BUILTIN_PERSONA_ID)!;
    await runNabyAction({ action: 'personaAutonomy.set', escalation: 'both', maxSteps: 8 });
    const after = getStore().getAgent(BUILTIN_PERSONA_ID)!;
    // The whole reason this is a setting: the store THROWS on a persona write, so
    // the delegation config has to live somewhere the user can actually reach.
    expect(after.autonomy).toEqual(before.autonomy);
    expect(after.updatedAt).toBe(before.updatedAt);
  });
});
/**
 * `systemMcp.set` / `.test` / `.remove` and the GET status (skill-hub-builtin §2.2).
 *
 * The registry's rules are unit-tested against a fake store in lib/systemMcp.test.ts.
 * What is tested HERE is the boundary: that a secret travels INWARDS ONLY. The user
 * types one or two strings, the server assembles the entry from the registry, and
 * no response on this route — not the write, not the probe, not the state read —
 * ever contains what they typed. That is asserted against the SERIALIZED response
 * rather than field by field, because a leak would arrive in a field nobody
 * thought to check.
 *
 * BOTH PRESETS ARE RUN THROUGH THE SAME CASES, because they leak differently:
 * skill-hub puts its secret in `headers`, atlassian in `env`, and `redactEntry`
 * has to strip both.
 */

const HUB_TOKEN = 'shub_test_secret_do_not_leak';
const ATLASSIAN_TOKEN = 'atl_test_secret_do_not_leak';
const ATLASSIAN_EMAIL = 'tester@altimedia.com';

/** Every response is JSON on the way to the renderer; search the whole of it. */
const leaks = (value: unknown, secret: string) => JSON.stringify(value ?? null).includes(secret);

const storedEntry = (name: string) =>
  getStore()
    .listMcpEntries()
    .find((e) => e.name === name);

/** Wipe both presets and both URL overrides, so no case inherits another's state. */
const clear = () => {
  const store = getStore();
  for (const name of SYSTEM_MCP_PRESET_NAMES) store.removeMcpEntry(name);
  store.setSetting(SKILL_HUB_URL_KEY, '');
  store.setSetting(ATLASSIAN_URL_KEY, '');
};

/**
 * A stand-in for uvx: a file that exists and is executable.
 *
 * The suite must be able to assert BOTH "uvx is present" and "uvx is absent"
 * regardless of whether the machine running it has uv installed, so the resolver's
 * explicit override (NABY_UVX_PATH) is pointed at this for the success cases and
 * at nothing for the refusal case. The entry that results is a real stdio entry
 * with a real absolute command — which is what makes the probe case below
 * meaningful: it fails at the MCP handshake, not at spawn.
 */
const UVX_ENV = commandPathEnvVar('uvx');
const fakeUvx = join(mkdtempSync(join(tmpdir(), 'naby-uvx-')), 'uvx');

beforeAll(() => {
  writeFileSync(fakeUvx, '#!/bin/sh\nexit 0\n');
  chmodSync(fakeUvx, 0o755);
});

afterAll(() => {
  delete process.env[UVX_ENV];
  clear();
});

/** uvx resolves (to the stand-in above). */
const withUvx = () => {
  process.env[UVX_ENV] = fakeUvx;
};

/** uvx does NOT resolve, whatever this machine has installed: an override that is
 *  set but wrong refuses rather than falling through to the real search. */
const withoutUvx = () => {
  process.env[UVX_ENV] = join(fakeUvx, 'missing', 'uvx');
};

describe('POST /api/naby — the skill-hub preset', () => {
  it('assembles the whole entry from the token alone', async () => {
    clear();
    const result = await runNabyAction({
      action: 'systemMcp.set',
      preset: SKILL_HUB_SERVER_NAME,
      fields: { token: HUB_TOKEN },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.systemMcp?.[SKILL_HUB_SERVER_NAME]).toEqual({
      configured: true,
      status: 'enabled',
    });
    // The answer covers EVERY preset, not just the one that changed, so a UI with
    // several rows refreshes them all from one reply.
    expect(result.systemMcp?.[ATLASSIAN_SERVER_NAME]).toEqual({ configured: false });

    // Read through the store the engine loads from, so this cannot pass on an
    // echo: the URL, the transport and the header name came from the server.
    const entry = storedEntry(SKILL_HUB_SERVER_NAME);
    expect(entry?.transport).toBe('http');
    expect(entry && entry.transport === 'http' && entry.url).toBe(DEFAULT_SKILL_HUB_URL);
    expect(entry && entry.transport === 'http' && entry.headers?.Authorization).toBe(
      `Bearer ${HUB_TOKEN}`,
    );
    clear();
  });

  it('refuses an empty or whitespace token, and stores nothing', async () => {
    clear();
    for (const token of ['', '   ', '\n\t', 'Bearer ']) {
      const result = await runNabyAction({
        action: 'systemMcp.set',
        preset: SKILL_HUB_SERVER_NAME,
        fields: { token },
      });
      expect(result.ok, `"${token}" should be refused`).toBe(false);
      if (result.ok) continue;
      // The refusal is translatable and names the field, so the UI can say which
      // box is empty in the user's own language.
      expect(result.errorKey).toBe('systemMcp.fieldRequired');
      expect(result.errorField).toBe('token');
    }
    // An `Authorization: Bearer ` entry would read as configured in the settings
    // row and 401 on the first turn — the worst of both answers.
    expect(storedEntry(SKILL_HUB_SERVER_NAME)).toBeUndefined();
  });

  it('strips a Bearer prefix the user pasted along with the token', async () => {
    clear();
    await runNabyAction({
      action: 'systemMcp.set',
      preset: SKILL_HUB_SERVER_NAME,
      fields: { token: `Bearer ${HUB_TOKEN}` },
    });
    const entry = storedEntry(SKILL_HUB_SERVER_NAME);
    expect(entry && entry.transport === 'http' && entry.headers?.Authorization).toBe(
      `Bearer ${HUB_TOKEN}`,
    );
    clear();
  });

  it('honours the skillHub.url override, which the UI never shows', async () => {
    clear();
    getStore().setSetting(SKILL_HUB_URL_KEY, 'https://staging.internal/mcp');
    await runNabyAction({
      action: 'systemMcp.set',
      preset: SKILL_HUB_SERVER_NAME,
      fields: { token: HUB_TOKEN },
    });
    const entry = storedEntry(SKILL_HUB_SERVER_NAME);
    expect(entry && entry.transport === 'http' && entry.url).toBe('https://staging.internal/mcp');

    // And the override is not smuggled back out with the status.
    const status = await runNabyAction({
      action: 'systemMcp.set',
      preset: SKILL_HUB_SERVER_NAME,
      fields: { token: HUB_TOKEN },
    });
    expect(leaks(status, 'staging.internal')).toBe(false);
    clear();
  });

  it('rejects a hand-broken override rather than storing an unreachable entry', async () => {
    clear();
    getStore().setSetting(SKILL_HUB_URL_KEY, 'not a url');
    const result = await runNabyAction({
      action: 'systemMcp.set',
      preset: SKILL_HUB_SERVER_NAME,
      fields: { token: HUB_TOKEN },
    });
    expect(result.ok).toBe(false);
    expect(storedEntry(SKILL_HUB_SERVER_NAME)).toBeUndefined();
    clear();
  });

  it('keeps the stored token when a save arrives with the box left blank', async () => {
    // The box IS blank every time the form opens — the value has no way back out
    // of the server — so a re-save must not wipe what is there.
    clear();
    await runNabyAction({
      action: 'systemMcp.set',
      preset: SKILL_HUB_SERVER_NAME,
      fields: { token: HUB_TOKEN },
    });
    const again = await runNabyAction({
      action: 'systemMcp.set',
      preset: SKILL_HUB_SERVER_NAME,
      fields: { token: '' },
    });
    expect(again.ok).toBe(true);
    const entry = storedEntry(SKILL_HUB_SERVER_NAME);
    expect(entry && entry.transport === 'http' && entry.headers?.Authorization).toBe(
      `Bearer ${HUB_TOKEN}`,
    );
    clear();
  });

  it('never puts the token in ANY response', async () => {
    clear();
    const set = await runNabyAction({
      action: 'systemMcp.set',
      preset: SKILL_HUB_SERVER_NAME,
      fields: { token: HUB_TOKEN },
    });
    expect(leaks(set, HUB_TOKEN)).toBe(false);

    // The probe reaches a real network address it cannot open, which is the
    // interesting case: the FAILURE path must not report the request it made.
    getStore().setSetting(SKILL_HUB_URL_KEY, 'http://127.0.0.1:1/mcp');
    await runNabyAction({
      action: 'systemMcp.set',
      preset: SKILL_HUB_SERVER_NAME,
      fields: { token: HUB_TOKEN },
    });
    const probe = await runNabyAction({ action: 'systemMcp.test', preset: SKILL_HUB_SERVER_NAME });
    expect(probe.ok, 'nothing is listening on port 1').toBe(false);
    expect(leaks(probe, HUB_TOKEN)).toBe(false);

    // The state read carries the entry in `mcp` too — through redactEntry, so it
    // is the header NAME that survives and never the value.
    const state = await readNabyState(null);
    expect(leaks(state, HUB_TOKEN)).toBe(false);
    const row = state.mcp.find((e) => e.name === SKILL_HUB_SERVER_NAME);
    expect(row?.headerKeys).toEqual(['Authorization']);
    expect(row).not.toHaveProperty('headers');

    const removed = await runNabyAction({
      action: 'systemMcp.remove',
      preset: SKILL_HUB_SERVER_NAME,
    });
    expect(leaks(removed, HUB_TOKEN)).toBe(false);
    clear();
  }, 20_000);

  it('reports the status on the GET, from the same reader the row uses', async () => {
    clear();
    const before = await readNabyState(null);
    expect(before.systemMcp[SKILL_HUB_SERVER_NAME]).toEqual({ configured: false });

    await runNabyAction({
      action: 'systemMcp.set',
      preset: SKILL_HUB_SERVER_NAME,
      fields: { token: HUB_TOKEN },
    });
    const after = await readNabyState(null);
    expect(after.systemMcp[SKILL_HUB_SERVER_NAME]).toEqual({ configured: true, status: 'enabled' });
    // Nothing non-secret to show: the token is all there is.
    expect(after.systemMcp[SKILL_HUB_SERVER_NAME]).not.toHaveProperty('nonSecretFields');
    clear();
  }, 20_000);

  it('shows an agent-proposed hub as proposed rather than connected', async () => {
    clear();
    // What `naby_add_mcp` writes: the agent may name the hub, but a server it
    // added does not run until a human approves it.
    getStore().upsertMcpEntry({
      name: SKILL_HUB_SERVER_NAME,
      transport: 'http',
      url: DEFAULT_SKILL_HUB_URL,
      status: 'proposed',
    });
    const state = await readNabyState(null);
    expect(state.systemMcp[SKILL_HUB_SERVER_NAME]).toEqual({
      configured: true,
      status: 'proposed',
    });

    // The existing approval path settles it — the preset adds no second one.
    const approved = await runNabyAction({ action: 'mcp.approve', name: SKILL_HUB_SERVER_NAME });
    expect(approved.ok).toBe(true);
    expect((await readNabyState(null)).systemMcp[SKILL_HUB_SERVER_NAME]).toEqual({
      configured: true,
      status: 'enabled',
    });
    clear();
  }, 20_000);

  it('removes the hub, and says so even when there was none', async () => {
    clear();
    await runNabyAction({
      action: 'systemMcp.set',
      preset: SKILL_HUB_SERVER_NAME,
      fields: { token: HUB_TOKEN },
    });
    const removed = await runNabyAction({
      action: 'systemMcp.remove',
      preset: SKILL_HUB_SERVER_NAME,
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.systemMcp?.[SKILL_HUB_SERVER_NAME]).toEqual({ configured: false });
    expect(storedEntry(SKILL_HUB_SERVER_NAME)).toBeUndefined();

    // Idempotent: removing what is not there is the state the caller asked for.
    const again = await runNabyAction({
      action: 'systemMcp.remove',
      preset: SKILL_HUB_SERVER_NAME,
    });
    expect(again.ok).toBe(true);
  });

  it('refuses to probe a hub that was never configured', async () => {
    clear();
    const result = await runNabyAction({ action: 'systemMcp.test', preset: SKILL_HUB_SERVER_NAME });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/skill-hub/);
  });
});

describe('POST /api/naby — the atlassian preset', () => {
  it('assembles a stdio entry around the RESOLVED uvx path', async () => {
    clear();
    withUvx();
    const result = await runNabyAction({
      action: 'systemMcp.set',
      preset: ATLASSIAN_SERVER_NAME,
      fields: { username: `  ${ATLASSIAN_EMAIL}  `, apiToken: ATLASSIAN_TOKEN },
    });
    expect(result.ok).toBe(true);

    const entry = storedEntry(ATLASSIAN_SERVER_NAME);
    expect(entry?.transport).toBe('stdio');
    if (!entry || entry.transport !== 'stdio') return;
    // ABSOLUTE, not the bare name: the packaged app's children do not inherit a
    // login-shell PATH, so a stored `uvx` would ENOENT on the user's machine.
    expect(entry.command).toBe(fakeUvx);
    expect(entry.command.startsWith('/')).toBe(true);
    expect(entry.args).toEqual([ATLASSIAN_PACKAGE]);
    expect(entry.env).toEqual({
      CONFLUENCE_URL: DEFAULT_CONFLUENCE_URL,
      CONFLUENCE_USERNAME: ATLASSIAN_EMAIL,
      CONFLUENCE_API_TOKEN: ATLASSIAN_TOKEN,
    });
    clear();
  });

  it('REFUSES the save when uvx cannot be resolved, and stores nothing', async () => {
    // The refusal is the feature (§2.1): failing here, with the user still
    // looking at the form, beats an entry that dies at the first turn weeks later.
    clear();
    withoutUvx();
    const result = await runNabyAction({
      action: 'systemMcp.set',
      preset: ATLASSIAN_SERVER_NAME,
      fields: { username: ATLASSIAN_EMAIL, apiToken: ATLASSIAN_TOKEN },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorKey).toBe('systemMcp.uvxMissing');
    // The English fallback is actionable on its own.
    expect(result.error).toContain('uv');
    expect(storedEntry(ATLASSIAN_SERVER_NAME)).toBeUndefined();
    clear();
  });

  it('refuses a missing field and a username that is not an email', async () => {
    clear();
    withUvx();
    const missing = await runNabyAction({
      action: 'systemMcp.set',
      preset: ATLASSIAN_SERVER_NAME,
      fields: { username: ATLASSIAN_EMAIL },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errorKey).toBe('systemMcp.fieldRequired');
      expect(missing.errorField).toBe('apiToken');
    }

    const badEmail = await runNabyAction({
      action: 'systemMcp.set',
      preset: ATLASSIAN_SERVER_NAME,
      fields: { username: 'tester', apiToken: ATLASSIAN_TOKEN },
    });
    expect(badEmail.ok).toBe(false);
    if (!badEmail.ok) {
      expect(badEmail.errorKey).toBe('systemMcp.presets.atlassian.badEmail');
      expect(badEmail.errorField).toBe('username');
    }
    expect(storedEntry(ATLASSIAN_SERVER_NAME)).toBeUndefined();
    clear();
  });

  it('keeps the stored API token when only the email is edited', async () => {
    // THE MULTI-FIELD CASE the one-field version could not have. The token box is
    // blank whenever the form opens, so a save that rebuilt from the typed values
    // alone would silently disconnect the server the user was merely renaming.
    clear();
    withUvx();
    await runNabyAction({
      action: 'systemMcp.set',
      preset: ATLASSIAN_SERVER_NAME,
      fields: { username: ATLASSIAN_EMAIL, apiToken: ATLASSIAN_TOKEN },
    });
    const edited = await runNabyAction({
      action: 'systemMcp.set',
      preset: ATLASSIAN_SERVER_NAME,
      fields: { username: 'other@altimedia.com', apiToken: '' },
    });
    expect(edited.ok).toBe(true);
    const entry = storedEntry(ATLASSIAN_SERVER_NAME);
    expect(entry && entry.transport === 'stdio' && entry.env).toEqual({
      CONFLUENCE_URL: DEFAULT_CONFLUENCE_URL,
      CONFLUENCE_USERNAME: 'other@altimedia.com',
      CONFLUENCE_API_TOKEN: ATLASSIAN_TOKEN,
    });
    clear();
  });

  it('honours the atlassian.confluenceUrl override', async () => {
    clear();
    withUvx();
    getStore().setSetting(ATLASSIAN_URL_KEY, 'https://other.atlassian.net/wiki');
    const result = await runNabyAction({
      action: 'systemMcp.set',
      preset: ATLASSIAN_SERVER_NAME,
      fields: { username: ATLASSIAN_EMAIL, apiToken: ATLASSIAN_TOKEN },
    });
    expect(result.ok).toBe(true);
    const entry = storedEntry(ATLASSIAN_SERVER_NAME);
    expect(entry && entry.transport === 'stdio' && entry.env?.CONFLUENCE_URL).toBe(
      'https://other.atlassian.net/wiki',
    );
    clear();
  });

  it('shows the email back and NEVER the token, in every response', async () => {
    clear();
    withUvx();
    const set = await runNabyAction({
      action: 'systemMcp.set',
      preset: ATLASSIAN_SERVER_NAME,
      fields: { username: ATLASSIAN_EMAIL, apiToken: ATLASSIAN_TOKEN },
    });
    expect(leaks(set, ATLASSIAN_TOKEN)).toBe(false);
    expect(set.ok && set.systemMcp?.[ATLASSIAN_SERVER_NAME]).toEqual({
      configured: true,
      status: 'enabled',
      // Non-secret: the user should see WHICH account is connected.
      nonSecretFields: { username: ATLASSIAN_EMAIL },
    });

    // The probe spawns the stand-in, which exits without speaking MCP — so this
    // is the failure path, where a naive implementation would report the command
    // line (and with it the env) it just tried to run.
    const probe = await runNabyAction({ action: 'systemMcp.test', preset: ATLASSIAN_SERVER_NAME });
    expect(probe.ok, 'the stand-in uvx speaks no MCP').toBe(false);
    expect(leaks(probe, ATLASSIAN_TOKEN)).toBe(false);

    // The state read carries the entry in `mcp` too — through redactEntry, which
    // must strip `env` VALUES exactly as it strips `headers` values.
    const state = await readNabyState(null);
    expect(leaks(state, ATLASSIAN_TOKEN)).toBe(false);
    const row = state.mcp.find((e) => e.name === ATLASSIAN_SERVER_NAME);
    expect(row?.envKeys).toEqual([
      'CONFLUENCE_URL',
      'CONFLUENCE_USERNAME',
      'CONFLUENCE_API_TOKEN',
    ]);
    expect(row).not.toHaveProperty('env');

    const removed = await runNabyAction({
      action: 'systemMcp.remove',
      preset: ATLASSIAN_SERVER_NAME,
    });
    expect(leaks(removed, ATLASSIAN_TOKEN)).toBe(false);
    expect(storedEntry(ATLASSIAN_SERVER_NAME)).toBeUndefined();
    clear();
  }, 30_000);

  it('reports its status on the GET, alongside the other preset', async () => {
    clear();
    withUvx();
    await runNabyAction({
      action: 'systemMcp.set',
      preset: ATLASSIAN_SERVER_NAME,
      fields: { username: ATLASSIAN_EMAIL, apiToken: ATLASSIAN_TOKEN },
    });
    const state = await readNabyState(null);
    expect(state.systemMcp[ATLASSIAN_SERVER_NAME]?.configured).toBe(true);
    expect(state.systemMcp[SKILL_HUB_SERVER_NAME]).toEqual({ configured: false });
    // Every preset in the registry has a key, so no row renders blank.
    expect(Object.keys(state.systemMcp).sort()).toEqual([...SYSTEM_MCP_PRESET_NAMES].sort());
    clear();
  }, 20_000);
});

describe('POST /api/naby — systemMcp rejects what it does not know', () => {
  it('refuses an unknown preset on every action', async () => {
    for (const action of ['systemMcp.set', 'systemMcp.test', 'systemMcp.remove'] as const) {
      const result = await runNabyAction({ action, preset: 'not-a-preset', fields: {} });
      expect(result.ok, `${action} accepted an unknown preset`).toBe(false);
      if (result.ok) continue;
      expect(result.error).toContain('not-a-preset');
    }
  });
});

/**
 * `telegram.set` — the SAVE is what turns two-way chat on (telegram-chat §2/§5).
 *
 * Two things have to happen the moment the config can chat, and neither of them
 * can wait for an escalation that may never come: the bot's command menu goes up
 * (so `/sessions` autocompletes in the input box) and the always-on listener
 * starts (so a message sent right after saving is answered).
 */
describe('POST /api/naby — telegram.set starts the chat (telegram-chat §5)', () => {
  afterEach(async () => {
    // Leave the throwaway store with Telegram OFF and no loop running: a live
    // long-poll against a fake token would outlive this file.
    await runNabyAction({ action: 'telegram.set', enabled: false });
    stopTelegramListener();
    await vi.waitFor(() => expect(telegramListenerRunning()).toBe(false), { timeout: 5000 });
    vi.unstubAllGlobals();
  });

  it('publishes the command menu and starts the listener', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        urls.push(String(input));
        return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
      }),
    );
    resetBotCommandRegistration();

    const result = await runNabyAction({
      action: 'telegram.set',
      enabled: true,
      botToken: 'TOKEN',
      chatId: '4242',
    });
    expect(result.ok).toBe(true);

    await vi.waitFor(() => expect(urls.some((u) => u.includes('/setMyCommands'))).toBe(true), {
      timeout: 4000,
    });
    await vi.waitFor(() => expect(telegramListenerRunning()).toBe(true), { timeout: 4000 });
  });

  it('does not start a listener for a half-written config', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: [] }) })),
    );
    // Enabled, but no chat id to send to: nothing to listen for yet.
    const result = await runNabyAction({ action: 'telegram.set', enabled: true, chatId: '' });
    expect(result.ok).toBe(true);
    expect(telegramListenerRunning()).toBe(false);
  });
});
