import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PARTICIPANT IMPORT / EXPORT — the MAC-M4 actions (agent-import-adapters §2–§5,
 * multi-agent-chat §8.4).
 *
 * Every test goes through `runNabyAction` against the throwaway database
 * vitest.setup.ts points NABY_DB_PATH at — never ~/.naby/app.db. The files are
 * the runtime spike's fixtures, so the shell and the spike read the same bytes.
 */
vi.mock('../engines/orchestrator', () => ({
  dispatchChat: async () => ({ ok: false as const, status: 503, error: 'no engine in tests' }),
}));

import { runNabyAction } from './naby';
import { getStore } from '../engines/naby';
import { buildPng, type ParticipantProfile } from '../../../../../../../dist/naby-runtime.mjs';
import { participantToolCatalog } from '../lib/participantImport';
import { PARTICIPANT_EXCLUDED_TOOLS } from '../lib/participantTurn';

const FIX = join(__dirname, '../../../../../../../src/spikes/fixtures/import');
const b64 = (name: string) => readFileSync(join(FIX, name)).toString('base64');

async function act(body: Record<string, unknown>) {
  return runNabyAction(body as never);
}

beforeEach(() => {
  const store = getStore();
  for (const a of store.listAgents()) if (a.kind === 'participant' || a.kind === 'custom') store.removeAgent(a.id);
});

const participants = () => getStore().listAgents().filter((a) => a.kind === 'participant');

describe('participant.import — two steps', () => {
  it('the first call returns the plan, losses and warnings and WRITES NOTHING', async () => {
    const before = getStore().listAgents().length;
    const r = await act({ action: 'participant.import', fileName: 'minji.v2.json', bytesBase64: b64('minji.v2.json') });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.participantImport).toMatchObject({ format: 'character-card-v2', applied: false });
    expect(r.participantImport!.agent).toMatchObject({ name: 'minji-kim', kind: 'participant', memoryScope: 'session', toolRefs: [] });
    expect(r.participantImport!.losses.some((l) => l.note === 'lore-disabled')).toBe(true);
    expect(r.participantImport!.report.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(getStore().listAgents().length).toBe(before);
    expect(r.participant).toBeUndefined();
  });

  it('apply:true writes a participant with the user\'s decisions (description, display name)', async () => {
    const r = await act({
      action: 'participant.import',
      fileName: 'minji.v2.json',
      bytesBase64: b64('minji.v2.json'),
      apply: true,
      decisions: { description: 'Korean tutor. Call for Korean phrasing.', displayName: '민지' },
    });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    const p = r.participant!;
    expect(p.kind).toBe('participant');
    expect(p.description).toBe('Korean tutor. Call for Korean phrasing.');
    expect(p.profile?.displayName).toBe('민지');
    expect(p.profile?.origin?.format).toBe('character-card-v2');
    expect(p.profile?.knowledge).toHaveLength(2);
    // Stored, and read back the same.
    const stored = getStore().getAgent(p.id)!;
    expect(stored.description).toBe('Korean tutor. Call for Korean phrasing.');
    expect(stored.toolRefs).toEqual([]);
    expect(r.participants?.some((x) => x.id === p.id)).toBe(true);
  });

  it('a second import of the same card is renamed, never overwritten — and the rename is re-checked at apply', async () => {
    const first = await act({ action: 'participant.import', fileName: 'minji.v2.json', bytesBase64: b64('minji.v2.json'), apply: true });
    expect(first.ok).toBe(true);
    const preview = await act({ action: 'participant.import', fileName: 'minji.v2.json', bytesBase64: b64('minji.v2.json') });
    expect(preview.ok && preview.participantImport!.agent.name).toBe('minji-kim-imported');
    expect(preview.ok && preview.participantImport!.report.renamedFrom).toBe('minji-kim');
    expect(preview.ok && preview.participantImport!.warnings).toContain('renamed');
    // Someone takes the suggested name between preview and apply…
    getStore().putAgent({
      name: 'MINJI-KIM-IMPORTED',
      kind: 'participant',
      systemPrompt: 'x',
      toolRefs: [],
      memoryScope: 'session',
      autonomy: { escalation: 'inline' },
      profile: { displayName: 'x', avatar: { kind: 'emoji', value: '🤖' }, color: '#123456', knowledge: [], guardrails: {}, mcpServers: [], skills: [] } as ParticipantProfile,
    });
    const applied = await act({ action: 'participant.import', fileName: 'minji.v2.json', bytesBase64: b64('minji.v2.json'), apply: true });
    expect(applied.ok, applied.ok ? '' : applied.error).toBe(true);
    expect(applied.ok && applied.participant!.name).toBe('minji-kim-imported-2');
    expect(participants().map((p) => p.name).sort()).toEqual(['MINJI-KIM-IMPORTED', 'minji-kim', 'minji-kim-imported-2']);
  });

  it('a handle the user typed that is taken (or is naby\'s) is refused at apply', async () => {
    await act({ action: 'participant.import', fileName: 'minji.v2.json', bytesBase64: b64('minji.v2.json'), apply: true });
    const taken = await act({
      action: 'participant.import',
      fileName: 'explorer.md',
      bytesBase64: b64('explorer.md'),
      apply: true,
      decisions: { name: 'Minji-Kim' },
    });
    expect(taken.ok).toBe(false);
    const hub = await act({ action: 'participant.import', fileName: 'explorer.md', bytesBase64: b64('explorer.md'), apply: true, decisions: { name: '나비' } });
    expect(hub.ok).toBe(false);
  });

  it('formatVersion 3 is rejected, and nothing is written', async () => {
    const r = await act({ action: 'participant.import', fileName: 'broken-future.naby.json', bytesBase64: b64('broken-future.naby.json'), apply: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('newer-format: 3');
    expect(participants()).toHaveLength(0);
  });

  it('a hostile file gets no persona kind, no tools it named, and its secrets masked', async () => {
    const r = await act({ action: 'participant.import', fileName: 'h.naby.json', bytesBase64: b64('broken-hostile.naby.json'), apply: true });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    const p = r.participant!;
    expect(p.kind).toBe('participant');
    expect(p.id).not.toBe('agent-persona-builtin');
    expect(p.name).toBe('naby-imported');
    expect(p.toolRefs?.includes('Bash')).toBe(false);
    expect(p.toolRefs?.includes('naby_remember')).toBe(false);
    expect(p.autonomy).toEqual({ escalation: 'inline' });
    expect(p.profile?.guardrails.policy).toMatch(/redacted/);
    // The real persona is untouched.
    expect(getStore().getAgent('agent-persona-builtin')?.kind).toBe('persona');
  });

  it('a PNG character card imports with its portrait as the avatar', async () => {
    const r = await act({ action: 'participant.import', fileName: 'minji.v3.png', bytesBase64: b64('minji.v3.png') });
    expect(r.ok && r.participantImport!.format).toBe('character-card-v3');
    expect(r.ok && r.participantImport!.agent.profile.avatar.kind).toBe('image');
  });

  it('bad requests: missing file name, non-base64, unknown format, unrecognised bytes', async () => {
    expect((await act({ action: 'participant.import', bytesBase64: b64('explorer.md') })).ok).toBe(false);
    expect((await act({ action: 'participant.import', fileName: 'x.md', bytesBase64: '***' })).ok).toBe(false);
    expect((await act({ action: 'participant.import', fileName: 'x.md', bytesBase64: b64('explorer.md'), format: 'letta-af' })).ok).toBe(false);
    const garbage = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff)).toString('base64');
    const r = await act({ action: 'participant.import', fileName: 'x.bin', bytesBase64: garbage });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unrecognized format');
  });

  it('a PNG with no card is refused with its own reason', async () => {
    const png = Buffer.from(buildPng({ width: 1, height: 1 })).toString('base64');
    const r = await act({ action: 'participant.import', fileName: 'x.png', bytesBase64: png });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('png-no-card');
  });
});

describe('participant.export / exportBundle', () => {
  it('exports the .md + sidecar v2 pair, and the pair imports back to the same profile', async () => {
    const imported = await act({ action: 'participant.import', fileName: 'minji.v2.json', bytesBase64: b64('minji.v2.json'), apply: true });
    expect(imported.ok).toBe(true);
    const id = imported.ok ? imported.participant!.id : '';
    const r = await act({ action: 'participant.export', id });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    const out = r.participantExport!;
    expect(out.markdownName).toBe('minji-kim.md');
    expect(JSON.parse(out.sidecar).formatVersion).toBe(2);
    expect(out.markdown).toMatch(/^---\nname: minji-kim\n/);
    expect(out.report.knowledgeItems).toBe(2);

    const back = await act({ action: 'participant.import', fileName: out.sidecarName, bytesBase64: Buffer.from(out.sidecar).toString('base64') });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const { origin: _a, ...was } = imported.ok ? imported.participant!.profile! : ({} as ParticipantProfile);
    const { origin: _b, ...now } = back.participantImport!.agent.profile;
    expect(now).toEqual(was);
  });

  it('refuses to export a non-participant', async () => {
    const r = await act({ action: 'participant.export', id: 'agent-persona-builtin' });
    expect(r.ok).toBe(false);
  });

  it('exportBundle returns one zip with a manifest', async () => {
    const a = await act({ action: 'participant.import', fileName: 'minji.v2.json', bytesBase64: b64('minji.v2.json'), apply: true });
    const b = await act({ action: 'participant.import', fileName: 'explorer.md', bytesBase64: b64('explorer.md'), apply: true });
    const ids = [a, b].map((x) => (x.ok ? x.participant!.id : ''));
    const r = await act({ action: 'participant.exportBundle', ids });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    const zip = Buffer.from(r.participantBundle!.base64, 'base64');
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(r.participantBundle!.manifest).toMatchObject({ formatVersion: 2, agents: ['minji-kim', 'explorer'] });
    expect(zip.includes(Buffer.from('manifest.json'))).toBe(true);
    expect(zip.includes(Buffer.from('explorer.naby.json'))).toBe(true);
  });
});

describe('agent.import points a participant file at participant import', () => {
  it('a v2 sidecar is refused with the hint and its i18n key', async () => {
    const imported = await act({ action: 'participant.import', fileName: 'minji.v2.json', bytesBase64: b64('minji.v2.json'), apply: true });
    const id = imported.ok ? imported.participant!.id : '';
    const exp = await act({ action: 'participant.export', id });
    const sidecar = exp.ok ? exp.participantExport!.sidecar : '';
    const r = await act({ action: 'agent.import', sidecar });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('if this is a participant file, use Import');
    expect(r.errorKey).toBe('agentImport.useParticipantImport');
  });

  it('a v1 sidecar still imports as a custom agent, without the hint', async () => {
    const r = await act({ action: 'agent.import', sidecar: readFileSync(join(FIX, 'legacy.v1.naby.json'), 'utf8') });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
  });
});

describe('tools.list', () => {
  it("offers naby's runtime tools a participant may hold, never naby's own learning/delegation tools", async () => {
    const r = await act({ action: 'tools.list' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tools).toEqual(participantToolCatalog());
    expect(r.tools).toContain('read_file');
    expect(r.tools).toContain('fetch_url');
    for (const ex of PARTICIPANT_EXCLUDED_TOOLS) expect(r.tools).not.toContain(ex);
  });
});
