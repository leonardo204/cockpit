import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * PARTICIPANT PERMISSION TIERS — the server's pure pieces (multi-agent-chat §8.14,
 * MAC-M7): the per-call allowlist at every level (MCP servers and their read-only
 * declarations included), who can be asked on which turn, the draft tool's
 * optional `permission`, the one write path keeping a stored tier, and the two
 * actions the editor reads (`participant.list` → `permission`, `tools.list` →
 * `tiers`/`levels`). The orchestrator is mocked so nothing here can start a model
 * turn; the store is the throwaway one vitest.setup.ts points NABY_DB_PATH at.
 */
vi.mock('../engines/orchestrator', () => ({
  dispatchChat: async () => ({ ok: false as const, status: 503, error: 'no engine in tests' }),
}));

import type { ParticipantProfile } from '../../../../../../../dist/naby-runtime.mjs';
import { getStore } from '../engines/naby';
import { runNabyAction } from '../api/naby';
import {
  participantApprovalReachable,
  participantMayBeOffered,
  participantMayUseTool,
  PARTICIPANT_EXCLUDED_TOOLS,
} from './participantTurn';
import { composeDraft, draftInputWithEdits, draftResultText, parseDraftToolInput } from './participantDraft';
import { putParticipant } from './participants';
import { approvalReasonsForTelegram, formatApprovalMessage } from './telegramEscalation';

const mcp = new Set(['jira__search', 'jira__create', 'wiki__read']);
const annotations = { jira__search: { readOnlyHint: true }, wiki__read: { readOnlyHint: true } };
const withLevel = (level: string, over: { toolRefs?: string[]; mcpServers?: string[]; approval?: string } = {}) => ({
  toolRefs: over.toolRefs ?? [],
  profile: { mcpServers: over.mcpServers ?? ['jira'], permission: { level, approval: over.approval ?? 'auto' } },
});
const may = (tool: string, agent: Parameters<typeof participantMayUseTool>[1]) =>
  participantMayUseTool(tool, agent, mcp, annotations);

describe('participantMayUseTool — inside the level, runs without asking (R10.1, R10.3)', () => {
  it('none: nothing, whatever toolRefs and MCP servers say', () => {
    const a = withLevel('none', { toolRefs: ['read_file'] });
    for (const t of ['read_file', 'echo_note', 'jira__search']) expect(may(t, a)).toBe(false);
  });
  it('read: reads, and the read-only tools of its own MCP servers', () => {
    const a = withLevel('read');
    for (const t of ['read_file', 'grep', 'fetch_url', 'naby_skill_load', 'jira__search']) expect(may(t, a)).toBe(true);
    for (const t of ['write_file', 'run_command', 'send_message', 'jira__create']) expect(may(t, a)).toBe(false);
  });
  it('read: an MCP server it was not given stays closed, read-only or not', () => {
    expect(may('wiki__read', withLevel('read'))).toBe(false);
    expect(may('wiki__read', withLevel('read', { mcpServers: ['wiki'] }))).toBe(true);
  });
  it('write: read + file edits', () => {
    const a = withLevel('write');
    for (const t of ['read_file', 'write_file', 'edit_file', 'Write', 'Edit']) expect(may(t, a)).toBe(true);
    for (const t of ['run_command', 'Bash', 'send_message', 'naby_start_job', 'jira__create']) expect(may(t, a)).toBe(false);
  });
  it('elevated: commands, jobs, messages, undeclared MCP tools — of its own servers', () => {
    const a = withLevel('elevated');
    for (const t of ['run_command', 'Bash', 'send_message', 'naby_start_job', 'jira__create', 'brand_new_tool']) {
      expect(may(t, a)).toBe(true);
    }
    expect(may('wiki__read', a)).toBe(false);
  });
  it('all: every tool in the turn, MCP servers it was not given included', () => {
    const a = withLevel('all', { mcpServers: [] });
    for (const t of ['run_command', 'jira__create', 'wiki__read', 'brand_new_tool']) expect(may(t, a)).toBe(true);
  });
  it('naby’s own tools are refused at every level', () => {
    for (const level of ['read', 'write', 'elevated', 'all', 'custom']) {
      for (const t of PARTICIPANT_EXCLUDED_TOOLS) expect(may(t, withLevel(level, { toolRefs: [t] }))).toBe(false);
    }
  });
  it('custom: the chip list (and its MCP servers) exactly as before', () => {
    const a = withLevel('custom', { toolRefs: ['read_file', 'wiki__read'] });
    expect(may('read_file', a)).toBe(true);
    expect(may('wiki__read', a)).toBe(true);
    expect(may('jira__create', a)).toBe(true);
    expect(may('grep', a)).toBe(false);
  });
  it('legacy (no permission): toolRefs → custom; MCP servers alone still work; nothing → nothing', () => {
    expect(may('read_file', { toolRefs: ['read_file'], profile: { mcpServers: [] } })).toBe(true);
    expect(may('grep', { toolRefs: ['read_file'], profile: { mcpServers: [] } })).toBe(false);
    expect(may('jira__create', { toolRefs: [], profile: { mcpServers: ['jira'] } })).toBe(true);
    expect(may('read_file', { toolRefs: [], profile: { mcpServers: [] } })).toBe(false);
  });
  it('without annotations an MCP tool is elevated (fail closed)', () => {
    expect(participantMayUseTool('jira__search', withLevel('read'), mcp)).toBe(false);
    expect(participantMayUseTool('jira__search', withLevel('elevated'), mcp)).toBe(true);
  });
});

describe('participantMayBeOffered — out-of-level tools are offered so they can ask (2026-10-19)', () => {
  it('everything but naby’s own tools', () => {
    for (const t of ['read_file', 'run_command', 'Bash', 'jira__create', 'brand_new_tool']) expect(participantMayBeOffered(t)).toBe(true);
    for (const t of PARTICIPANT_EXCLUDED_TOOLS) expect(participantMayBeOffered(t)).toBe(false);
  });
});

describe('participantApprovalReachable — who can answer "ask me every time" (R10.2)', () => {
  it('chat always; Telegram only when the question goes to the phone; nothing else', () => {
    expect(participantApprovalReachable('chat', false)).toBe(true);
    expect(participantApprovalReachable('telegram', true)).toBe(true);
    expect(participantApprovalReachable('telegram', false)).toBe(false);
    expect(participantApprovalReachable('scheduled', true)).toBe(false);
    expect(participantApprovalReachable('kickoff', false)).toBe(false);
  });
  it('the phone copy and the in-app copy say why it asks', () => {
    expect(approvalReasonsForTelegram({ source: 'participant_always' })).toEqual([
      'This participant asks you before every tool use',
    ]);
  });
});

const profile: ParticipantProfile = {
  displayName: 'Reader',
  avatar: { kind: 'emoji', value: '📖' },
  color: '#0ea5e9',
  knowledge: [],
  guardrails: {},
  mcpServers: [],
  skills: [],
};

afterEach(() => {
  const store = getStore();
  for (const a of store.listAgents()) if (a.kind === 'participant') store.removeAgent(a.id);
});

describe('the draft tool’s optional permission (R10.4, §8.12)', () => {
  const base = { action: 'create', name: 'perm-draft', instructions: 'You read.', displayName: 'Reader' };
  it('parses a level and an approval; refuses custom and junk', () => {
    expect(parseDraftToolInput({ ...base, permission: { level: 'read', approval: 'always' } })).toMatchObject({
      ok: true,
      input: { permission: { level: 'read', approval: 'always' } },
    });
    expect(parseDraftToolInput({ ...base, permission: { level: 'write' } })).toMatchObject({
      ok: true,
      input: { permission: { level: 'write', approval: 'auto' } },
    });
    expect(parseDraftToolInput({ ...base, permission: { level: 'custom' } }).ok).toBe(false);
    expect(parseDraftToolInput({ ...base, permission: { level: 'read', approval: 'never' } }).ok).toBe(false);
    expect(parseDraftToolInput({ ...base, permission: 'read' }).ok).toBe(false);
  });
  it('create without one: no permission written — the participant has no tools', () => {
    const r = composeDraft(getStore(), { action: 'create', name: 'perm-none', instructions: 'x' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.composed.draft.permission).toBeUndefined();
    expect((r.composed.putBody.profile as ParticipantProfile).permission).toBeUndefined();
    expect(r.composed.putBody.toolRefs).toEqual([]);
  });
  it('create with one: on the card and in the saved profile', () => {
    const r = composeDraft(getStore(), {
      action: 'create',
      name: 'perm-read',
      instructions: 'x',
      permission: { level: 'read', approval: 'always' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.composed.draft.permission).toEqual({ level: 'read', approval: 'always' });
    const saved = putParticipant(getStore(), r.composed.putBody);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.participant.profile?.permission).toEqual({ level: 'read', approval: 'always' });
    // Carried through the card's edits to the second composition.
    expect(draftInputWithEdits(r.composed.draft, { displayName: 'R' }).permission).toEqual({ level: 'read', approval: 'always' });
  });
  it('update: a new level is a change; the same level, or none named, is not', () => {
    const store = getStore();
    const p = store.putAgent({
      name: 'perm-upd',
      kind: 'participant',
      systemPrompt: 'You read.',
      toolRefs: ['read_file'],
      memoryScope: 'session',
      autonomy: { escalation: 'inline' },
      profile,
    });
    const changed = composeDraft(store, { action: 'update', id: p.id, permission: { level: 'write', approval: 'auto' } });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.composed.changed).toEqual(['permission']);
    expect(changed.composed.before?.permission).toEqual({ level: 'custom', approval: 'auto' });
    expect((changed.composed.putBody.profile as ParticipantProfile).permission).toEqual({ level: 'write', approval: 'auto' });
    // A legacy row's reading stays the legacy reading when nothing names it.
    const same = composeDraft(store, { action: 'update', id: p.id, description: 'Reads things.' });
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect(same.composed.changed).toEqual(['description']);
    expect((same.composed.putBody.profile as ParticipantProfile).permission).toBeUndefined();
    expect(composeDraft(store, { action: 'update', id: p.id, permission: { level: 'custom', approval: 'auto' } })).toMatchObject({
      ok: false,
      error: 'the draft changes nothing',
    });
  });
  it('the result text and the phone copy name it', () => {
    expect(draftResultText({ kind: 'saved', action: 'update', name: 'x', changed: ['permission'], edited: [], session: 'not-requested' })).toContain('권한');
    const msg = formatApprovalMessage({
      toolName: 'participant.create',
      input: { draft: { name: 'r', displayName: 'R', permission: { level: 'read', approval: 'always' } }, addToSession: true },
    });
    expect(msg).toContain('· 권한: 읽기만 · 도구를 쓸 때마다 승인');
  });
});

describe('the write path and the actions', () => {
  it('putParticipant keeps a stored permission when a profile arrives without one', () => {
    const store = getStore();
    const first = putParticipant(store, {
      name: 'perm-keep',
      instructions: 'x',
      profile: { ...profile, permission: { level: 'write', approval: 'always' } },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = putParticipant(store, { id: first.participant.id, name: 'perm-keep', instructions: 'y', profile });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.participant.profile?.permission).toEqual({ level: 'write', approval: 'always' });
    const changed = putParticipant(store, {
      id: first.participant.id,
      name: 'perm-keep',
      instructions: 'y',
      profile: { ...profile, permission: { level: 'none', approval: 'auto' } },
    });
    expect(changed.ok && changed.participant.profile?.permission).toEqual({ level: 'none', approval: 'auto' });
  });

  it('putParticipant refuses a bad level (the profile gate)', () => {
    const r = putParticipant(getStore(), {
      name: 'perm-bad',
      instructions: 'x',
      profile: { ...profile, permission: { level: 'root' } },
    });
    expect(r).toMatchObject({ ok: false });
  });

  it('participant.list carries the effective permission, legacy rows included', async () => {
    const store = getStore();
    store.putAgent({ name: 'perm-legacy', kind: 'participant', systemPrompt: 'x', toolRefs: ['grep'], memoryScope: 'session', autonomy: { escalation: 'inline' }, profile });
    store.putAgent({ name: 'perm-empty', kind: 'participant', systemPrompt: 'x', toolRefs: [], memoryScope: 'session', autonomy: { escalation: 'inline' }, profile });
    store.putAgent({
      name: 'perm-set',
      kind: 'participant',
      systemPrompt: 'x',
      toolRefs: ['grep'],
      memoryScope: 'session',
      autonomy: { escalation: 'inline' },
      profile: { ...profile, permission: { level: 'read', approval: 'always' } },
    });
    const r = (await runNabyAction({ action: 'participant.list' } as never)) as {
      ok: boolean;
      participants: { name: string; permission?: unknown }[];
    };
    expect(r.ok).toBe(true);
    const by = (n: string) => r.participants.find((p) => p.name === n)?.permission;
    expect(by('perm-legacy')).toEqual({ level: 'custom', approval: 'auto' });
    expect(by('perm-empty')).toEqual({ level: 'none', approval: 'auto' });
    expect(by('perm-set')).toEqual({ level: 'read', approval: 'always' });
  });

  it('tools.list returns each tool’s tier and each level’s tools, nested', async () => {
    const r = (await runNabyAction({ action: 'tools.list' } as never)) as {
      ok: boolean;
      tools: string[];
      tiers: Record<string, string>;
      levels: Record<string, string[]>;
    };
    expect(r.ok).toBe(true);
    expect(r.tiers.read_file).toBe('read');
    expect(r.tiers.write_file).toBe('write');
    expect(r.tiers.run_command).toBe('elevated');
    expect(Object.keys(r.tiers).sort()).toEqual([...r.tools].sort());
    expect(r.levels.none).toEqual([]);
    expect(r.levels.read).toContain('read_file');
    expect(r.levels.read).not.toContain('write_file');
    expect(r.levels.write).toEqual(expect.arrayContaining([...r.levels.read, 'write_file']));
    expect(r.levels.elevated).toEqual(expect.arrayContaining([...r.levels.write, 'run_command']));
    expect([...r.levels.all].sort()).toEqual([...r.tools].sort());
    // naby's own tools are not offered at any level.
    for (const t of PARTICIPANT_EXCLUDED_TOOLS) expect(r.levels.all).not.toContain(t);
  });
});
