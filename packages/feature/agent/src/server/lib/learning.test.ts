import { describe, it, expect } from 'vitest';
import { canLearn, learningInstruction } from './learning';
import type { Agent } from '../../../../../../../dist/naby-runtime.mjs';

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    name: 'nabi',
    kind: 'persona',
    systemPrompt: 'you are nabi',
    memoryScope: 'user',
    autonomy: { escalation: 'inline' },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('learning — when the agent may learn (P3-M4b)', () => {
  it('an unrestricted agent can learn', () => {
    expect(canLearn(agent())).toBe(true);
  });

  it('a plain turn with no routed agent cannot — the tool is not even built', () => {
    expect(canLearn(undefined)).toBe(false);
  });

  it('an allowlisted agent can learn only when the tool is on its list', () => {
    expect(canLearn(agent({ toolRefs: ['naby_remember', 'echo_note'] }))).toBe(true);
    // Restricted to other tools: the gate would deny the call, so the instruction
    // must NOT be injected (no silent half-run).
    expect(canLearn(agent({ toolRefs: ['echo_note'] }))).toBe(false);
    expect(canLearn(agent({ toolRefs: [] }))).toBe(false);
  });

  it('compares names exactly, the same way the gate does', () => {
    // The P3-M2 allowlist check is `toolRefs.includes(normalizeToolName(name))`,
    // and normalizeToolName is identity today — so a similarly-named MCP tool is
    // a DIFFERENT tool and must not enable learning. canLearn has to agree with
    // the gate, or the instruction would promise a call the gate then denies.
    expect(canLearn(agent({ toolRefs: ['mcp__x__naby_remember'] }))).toBe(false);
    expect(canLearn(agent({ toolRefs: ['naby_remember'] }))).toBe(true);
  });
});

describe('learning — the injected instruction', () => {
  it('names the tool, the agent scope and its reach', () => {
    const text = learningInstruction(agent({ memoryScope: 'project' }));
    expect(text).toContain('naby_remember');
    expect(text).toContain('"project"');
    expect(text).toContain('this working directory only');
  });

  it('states the three things a model gets wrong unprompted', () => {
    const text = learningInstruction(agent());
    // (1) a capture is a proposal, not a live fact
    expect(text).toMatch(/PROPOSAL/);
    expect(text).toMatch(/now applied/);
    // (2) durability is the bar
    expect(text).toMatch(/still be true next week/);
    // (3) never store credentials
    expect(text).toMatch(/secrets|credential/);
  });

  it('reads the scope off the agent, not a constant', () => {
    expect(learningInstruction(agent({ memoryScope: 'session' }))).toContain('this conversation only');
    expect(learningInstruction(agent({ memoryScope: 'user' }))).toContain('everywhere, for this user');
  });
});
