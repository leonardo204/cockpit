// Model-facing refusal reasons say what happened, which real control lifts it,
// and what to do now — and never the internal jargon they used to (2026-10-30).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decideMemoryWrite,
  realPolicy,
  stageContract,
  stageRefusalReason,
} from '../../../../../../../dist/naby-runtime.mjs';
import {
  agentToolRefsReason,
  approvalTimeoutReason,
  orgHookDenyReason,
  participantUnreachableReason,
  PARTICIPANT_DRAFT_BLOCKED_REASON,
  userDeclinedReason,
} from './refusalReasons';

const JARGON = /Phase [12]|policy gate|stage contract|allowlist|observation mode|tier|scope escalation/i;

const locale = (lang: 'en' | 'ko') =>
  JSON.parse(readFileSync(join(__dirname, `../../../../../shared/i18n/locales/${lang}.json`), 'utf8')) as Record<
    string,
    Record<string, unknown>
  >;
const en = locale('en');
const ko = locale('ko');
const pick = (d: Record<string, unknown>, path: string): string =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], d) as string;

describe('the labels quoted in the reasons are the UI labels', () => {
  // A reason that names a control the UI does not show sends the user hunting.
  const cases: Array<[string, string]> = [
    ['policyManager.title', 'Settings → Permissions'],
    ['policyManager.effect_ask', '"Ask each time"'],
    ['settings.connections', 'Settings → Connections'],
    ['telegramSettings.enable', '"Enable Telegram escalation"'],
    ['participants.permission.label', '"What it may do"'],
    ['participants.permission.always', '"Ask me every time it uses a tool"'],
    ['agentManager.delegationEscalation', '"Reach me via"'],
  ];
  const all = [
    approvalTimeoutReason('Bash'),
    participantUnreachableReason('Bash', 'scout', true),
    participantUnreachableReason('Bash', 'scout', false),
    PARTICIPANT_DRAFT_BLOCKED_REASON,
  ].join('\n');
  it.each(cases)('%s', (key) => {
    expect(all).toContain(pick(en, key));
    expect(all).toContain(pick(ko, key));
  });
});

describe('shell refusal reasons', () => {
  it('approval timeout: did not run, do not retry, three ways out', () => {
    const r = approvalTimeoutReason('Bash', 10);
    expect(r).toMatch(/^Nobody approved Bash within 10 minutes, so it did not run\. Do not retry it\./);
    expect(r).toContain('Telegram');
    expect(r).toContain('Settings → Permissions');
  });

  it('user declined: where, and no retry / no workaround', () => {
    expect(userDeclinedReason('app')).toContain('in the app');
    expect(userDeclinedReason('telegram')).toContain('from Telegram');
    expect(userDeclinedReason('app')).toMatch(/Do not retry it or work around it/);
  });

  it('participant with nobody to ask names the setting that applies', () => {
    expect(participantUnreachableReason('Bash', 'scout', true)).toContain('"What it may do"');
    expect(participantUnreachableReason('Bash', 'scout', false)).toContain('"Ask me every time it uses a tool"');
    expect(participantUnreachableReason('Bash', 'scout', true)).toMatch(/not started from the chat window/);
  });

  it('org hook: mandatory, names the script and the hook reason', () => {
    const r = orgHookDenyReason('task/guard.py', 'no pushes to main');
    expect(r).toContain('(task/guard.py): no pushes to main.');
    expect(r).toMatch(/cannot be switched off/);
    expect(orgHookDenyReason('task/guard.py')).toContain('(task/guard.py). This rule');
  });

  it('imported agent: names the tool and the fixed list, offers naby itself', () => {
    const r = agentToolRefsReason('Bash', 'scout', ['Read', 'Grep']);
    expect(r).toContain('@scout cannot use Bash');
    expect(r).toContain('(Read, Grep)');
    expect(r).toContain('without @scout');
  });

  it('none of them uses internal jargon', () => {
    for (const r of [
      approvalTimeoutReason('Bash'),
      userDeclinedReason('app'),
      participantUnreachableReason('Bash', 'scout', true),
      orgHookDenyReason('x.py'),
      agentToolRefsReason('Bash', 'scout', []),
      PARTICIPANT_DRAFT_BLOCKED_REASON,
    ]) {
      expect(r).not.toMatch(JARGON);
    }
  });
});

describe('runtime refusal reasons', () => {
  it("a Block rule names Settings → Permissions and says not to work around it", async () => {
    const d = await realPolicy({
      rules: [{ toolPattern: 'Bash', effect: 'deny' }] as never,
      fallback: () => ({ behavior: 'allow' }),
    })({ toolCallId: 't', toolName: 'Bash', input: {} });
    expect(d.behavior).toBe('deny');
    const reason = d.behavior === 'deny' ? d.reason : '';
    expect(reason).toContain('Settings → Permissions (설정 → 권한)');
    expect(reason).toMatch(/Do not retry it or use another tool/);
    expect(reason).not.toMatch(JARGON);
  });

  it('the growth-stage refusal speaks of the growth stage, with the Korean stage name', () => {
    const r = stageRefusalReason({ toolName: 'write_file', stage: 'larva', contract: stageContract('larva') }) ?? '';
    expect(r).toContain('growth stage');
    expect(r).toContain('larva (애벌레)');
    expect(r).toContain('naby itself (without @agent)');
    expect(r).not.toMatch(JARGON);
  });

  it('memory: external text into user scope, and overwriting a confirmed memory', () => {
    const escalate = decideMemoryWrite({
      scope: 'user',
      scopeKey: 'u',
      type: 'preference',
      key: 'k',
      value: 'v',
      provenance: { source: 'external' },
      requestedStatus: 'proposed',
    } as never);
    expect(escalate.behavior).toBe('deny');
    expect(escalate.reason).toMatch(/web page or tool output/);
    expect(escalate.reason).not.toMatch(JARGON);

    const overwrite = decideMemoryWrite(
      {
        scope: 'user',
        scopeKey: 'u',
        type: 'preference',
        key: 'tone',
        value: 'v2',
        provenance: { source: 'artifact' },
        requestedStatus: 'proposed',
      } as never,
      { status: 'confirmed', provenance: { source: 'user' } } as never,
    );
    expect(overwrite.behavior).toBe('deny');
    expect(overwrite.reason).toContain('the user already confirmed a memory under "tone"');
    expect(overwrite.reason).toContain('Settings → Memory');
    expect(overwrite.reason).not.toMatch(JARGON);
  });
});
