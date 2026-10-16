import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * THE PARTICIPANT PROPOSAL on the approval bridge (multi-agent-chat §8.2, R3.9,
 * MAC-M2): its Telegram copy, and the rule that "remember" never turns it into
 * a policy rule. Plus the pure pieces of a participant's speech (participantTurn).
 * The orchestrator is mocked so nothing here can start a model turn.
 */
vi.mock('../engines/orchestrator', () => ({
  dispatchChat: async () => ({ ok: false as const, status: 503, error: 'no engine in tests' }),
}));

import { formatApprovalMessage } from './telegramEscalation';
import {
  approvalMayRemember,
  hasPendingApproval,
  PARTICIPANT_ADD_TOOL,
  pendingApprovalToolName,
  registerApproval,
  unregisterApproval,
} from './approvalRegistry';
import {
  participantMayUseTool,
  PARTICIPANT_EXCLUDED_TOOLS,
  recentForRoute,
  resolveParticipantModel,
  roundResultText,
} from './participantTurn';
import { runNabyAction } from '../api/naby';
import { getStore } from '../engines/naby';

describe('formatApprovalMessage — participant.add', () => {
  const msg = formatApprovalMessage({
    toolName: 'participant.add',
    input: {
      agentId: 'p1',
      name: '번역가',
      displayName: 'Translator',
      avatar: { kind: 'emoji', value: '🌐' },
      description: 'Translates Korean and English.',
      reason: '영어 번역 요청이에요',
    },
    project: 'naby',
  });
  it('asks as naby, in Korean, naming the participant', () => {
    expect(msg).toContain('🦋 나비의 제안: @번역가를 참가자로 추가해서 맡길까요?');
  });
  it('carries the identity, description and reason', () => {
    expect(msg).toContain('🌐 Translator');
    expect(msg).toContain('Translates Korean and English.');
    expect(msg).toContain('· 이유: 영어 번역 요청이에요');
  });
  it('is not a tool card', () => {
    expect(msg).not.toContain('needs approval');
    expect(msg).not.toContain('Tool:');
  });
  it('a tool approval is unchanged', () => {
    expect(formatApprovalMessage({ toolName: 'Bash', input: { command: 'ls' } })).toContain('🔐 naby needs approval');
  });
});

describe('approval.resolve ignores "remember" for participant.add', () => {
  const userRules = () => getStore().listPolicyRules('user', 'local');
  afterEach(() => {
    for (const r of userRules()) {
      if (r.toolPattern === PARTICIPANT_ADD_TOOL || r.toolPattern === 'mac_m2_probe_tool') getStore().removePolicyRule(r.id);
    }
  });

  it('the registry remembers what a pending approval is about', () => {
    registerApproval('x1', () => {}, 1, { toolName: PARTICIPANT_ADD_TOOL });
    expect(pendingApprovalToolName('x1')).toBe(PARTICIPANT_ADD_TOOL);
    expect(approvalMayRemember('x1', 'anything')).toBe(false);
    unregisterApproval('x1');
    expect(approvalMayRemember('x2', 'participant.add')).toBe(false);
    expect(approvalMayRemember('x2', 'Bash')).toBe(true);
  });

  it('resolving a proposal with remember=true settles it and writes no rule', async () => {
    let decided: string | undefined;
    registerApproval('prop-1', (d) => void (decided = d.behavior), 1, { toolName: PARTICIPANT_ADD_TOOL });
    const before = userRules().length;
    const r = await runNabyAction({
      action: 'approval.resolve',
      approvalId: 'prop-1',
      decision: 'allow',
      remember: true,
      scope: 'user',
      toolPattern: PARTICIPANT_ADD_TOOL,
    } as never);
    expect(r).toMatchObject({ ok: true, resolved: true });
    expect(decided).toBe('allow');
    expect(hasPendingApproval('prop-1')).toBe(false);
    expect(userRules().length).toBe(before);
    expect(userRules().some((rule) => rule.toolPattern === PARTICIPANT_ADD_TOOL)).toBe(false);
  });
});

describe('approval.resolve — the control case', () => {
  it('a TOOL approval with remember=true still writes its rule', async () => {
    registerApproval('tool-1', () => {}, 1, { toolName: 'mac_m2_probe_tool' });
    const r = await runNabyAction({
      action: 'approval.resolve',
      approvalId: 'tool-1',
      decision: 'allow',
      remember: true,
      scope: 'user',
      toolPattern: 'mac_m2_probe_tool',
    } as never);
    expect(r).toMatchObject({ ok: true, resolved: true });
    const rules = getStore().listPolicyRules('user', 'local');
    expect(rules.some((rule) => rule.toolPattern === 'mac_m2_probe_tool')).toBe(true);
    for (const rule of rules) if (rule.toolPattern === 'mac_m2_probe_tool') getStore().removePolicyRule(rule.id);
  });
});

describe('participantTurn — tools, model, recent, result text', () => {
  const mcp = new Set(['jira__search', 'jira__create', 'wiki__read']);
  const agent = { toolRefs: ['read_file', 'naby_remember'], profile: { mcpServers: ['jira'] } };
  it('toolRefs and the profile’s MCP servers decide; naby’s own tools never pass', () => {
    expect(participantMayUseTool('read_file', agent, mcp)).toBe(true);
    expect(participantMayUseTool('jira__search', agent, mcp)).toBe(true);
    expect(participantMayUseTool('wiki__read', agent, mcp)).toBe(false);
    expect(participantMayUseTool('write_file', agent, mcp)).toBe(false);
    expect(participantMayUseTool('naby_remember', agent, mcp)).toBe(false);
    for (const t of PARTICIPANT_EXCLUDED_TOOLS) expect(participantMayUseTool(t, { toolRefs: [t] }, mcp)).toBe(false);
  });
  it('an imported participant (toolRefs []) gets nothing', () => {
    expect(participantMayUseTool('read_file', { toolRefs: [] }, mcp)).toBe(false);
    expect(participantMayUseTool('jira__search', { toolRefs: [] }, mcp)).toBe(false);
  });
  it('model: own when the engine can run it, else the session’s with a note', () => {
    expect(resolveParticipantModel('dev-claude', undefined, 'sonnet')).toEqual({ model: 'sonnet' });
    expect(resolveParticipantModel('dev-claude', 'haiku', 'sonnet')).toEqual({ model: 'haiku' });
    expect(resolveParticipantModel('dev-claude', 'claude-opus-5-5', 'sonnet')).toEqual({ model: 'claude-opus-5-5' });
    expect(resolveParticipantModel('dev-claude', 'gpt-5', 'sonnet')).toEqual({ model: 'sonnet', fallbackFrom: 'gpt-5' });
    expect(resolveParticipantModel('ai-sdk', 'gpt-4o', 'gpt-5')).toEqual({ model: 'gpt-4o' });
    expect(resolveParticipantModel('ai-sdk', 'claude-x', 'gpt-5')).toEqual({ model: 'gpt-5', fallbackFrom: 'claude-x' });
  });
  it('recent messages are labelled by speaker; hand-offs are naby → @x', () => {
    const r = recentForRoute(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'do it', speaker: { agentId: 'n', name: 'naby' }, routing: { kind: 'delegate', targetName: 'tr' } },
        { role: 'assistant', content: 'done', speaker: { agentId: 't', name: 'tr' } },
        { role: 'tool', toolCallId: 'x', toolName: 'y', output: { content: 'z', isError: false } },
      ],
      'naby',
    );
    expect(r).toEqual([
      { speaker: 'user', text: 'hi' },
      { speaker: 'naby', text: 'hello' },
      { speaker: 'naby → @tr', text: 'do it' },
      { speaker: '@tr', text: 'done' },
    ]);
  });
  it('the round’s closing text labels participant speech only', () => {
    const tr = { id: 't', name: 'tr', displayName: 'Translator', description: '', avatar: { kind: 'emoji' as const, value: '🌐' } };
    const naby = { id: 'n', name: 'naby', displayName: '나비', description: '' };
    expect(roundResultText([{ agent: naby, persona: true, text: 'plain' }])).toBe('plain');
    expect(roundResultText([{ agent: tr, persona: false, text: 'Hello' }])).toBe('🌐 Translator:\nHello');
    expect(
      roundResultText([
        { agent: tr, persona: false, text: 'Hello' },
        { agent: naby, persona: true, text: 'Anything else?' },
      ]),
    ).toBe('🌐 Translator:\nHello\n\nAnything else?');
  });
});
