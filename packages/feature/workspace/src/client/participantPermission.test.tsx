import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { ParticipantEditor } from './ParticipantEditor';
import { ParticipantPermissionField } from './ParticipantPermissionField';
import { ParticipantCard } from './ParticipantSection';
import {
  blankParticipantForm,
  formFromDraft,
  formFromParticipant,
  participantPutBody,
  withToolRefs,
} from './participantForm';

/**
 * THE EDITOR'S PERMISSION FIELD (multi-agent-chat §8.14, R10.6, MAC-M7): the form
 * reading and writing `permission` (legacy rows included), the chips selecting
 * `custom`, the five cards with their tool lists, the "ask me every time" switch,
 * the warning for the two risky levels, the folded "pick tools yourself" option,
 * and the roster card's badge. Rendered statically, like the other Settings
 * tests (jsdom has no layout, and nothing here needs one).
 */

const render = (node: ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const noop = () => {};
const LEVELS = {
  none: [],
  read: ['grep', 'read_file'],
  write: ['grep', 'read_file', 'write_file'],
  elevated: ['grep', 'read_file', 'write_file', 'run_command'],
  all: ['grep', 'read_file', 'write_file', 'run_command'],
};

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage('en');
});

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'reader',
  systemPrompt: 'You read.',
  toolRefs: [],
  memoryScope: 'session',
  profile: {
    displayName: 'Reader',
    avatar: { kind: 'emoji', value: '📖' },
    color: '#0EA5E9',
    knowledge: [],
    guardrails: {},
    mcpServers: [],
    skills: [],
  },
  ...over,
});

describe('participantForm and permission (R10.4)', () => {
  it('a new form starts with no tools, asking as the turn decides', () => {
    expect(blankParticipantForm().permission).toEqual({ level: 'none', approval: 'auto' });
  });
  it('reads the effective permission the server sends', () => {
    expect(formFromParticipant(row({ permission: { level: 'write', approval: 'always' } })).permission).toEqual({
      level: 'write',
      approval: 'always',
    });
  });
  it('without it: the stored profile value, else the legacy reading', () => {
    const p = row().profile;
    expect(formFromParticipant(row({ profile: { ...p, permission: { level: 'read' } } })).permission.level).toBe('read');
    expect(formFromParticipant(row({ toolRefs: ['grep'] })).permission.level).toBe('custom');
    expect(formFromParticipant(row({ profile: { ...p, mcpServers: ['jira'] } })).permission.level).toBe('custom');
    expect(formFromParticipant(row()).permission.level).toBe('none');
  });
  it('a draft may carry a tier; without one it has none', () => {
    const d = {
      name: 'r',
      displayName: 'R',
      description: '',
      instructions: 'x',
      guardrailsPolicy: '',
      greeting: '',
      avatar: { kind: 'emoji' as const, value: '📖' },
      color: '#0EA5E9',
    };
    expect(formFromDraft(d).permission).toEqual({ level: 'none', approval: 'auto' });
    expect(formFromDraft({ ...d, permission: { level: 'read', approval: 'always' } }).permission).toEqual({
      level: 'read',
      approval: 'always',
    });
  });
  it('the put body saves it in the profile and keeps the chips for later', () => {
    const f = { ...formFromParticipant(row({ toolRefs: ['grep'] })), permission: { level: 'read' as const, approval: 'always' as const } };
    const body = participantPutBody(f);
    expect((body.profile as { permission: unknown }).permission).toEqual({ level: 'read', approval: 'always', approvedTools: [] });
    expect(body.toolRefs).toEqual(['grep']);
  });
  it('touching the chips selects custom and keeps the approval mode', () => {
    const f = { ...blankParticipantForm(), permission: { level: 'read' as const, approval: 'always' as const } };
    const next = withToolRefs(f, ['grep']);
    expect(next.toolRefs).toEqual(['grep']);
    expect(next.permission).toEqual({ level: 'custom', approval: 'always' });
  });
});

describe('ParticipantPermissionField (R10.6)', () => {
  const field = (level: 'none' | 'read' | 'write' | 'elevated' | 'all' | 'custom', approval: 'auto' | 'always' = 'auto') =>
    render(
      <ParticipantPermissionField
        value={{ level, approval }}
        levels={LEVELS}
        onChange={noop}
        customEditor={<div data-testid="chip-editor">chips</div>}
      />,
    );

  it('five cards with one line each; the chosen one is checked', () => {
    const html = field('read');
    for (const l of ['none', 'read', 'write', 'elevated', 'all']) expect(html).toContain(`data-testid="permission-level-${l}"`);
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*data-testid="permission-level-read"/);
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*data-testid="permission-level-write"/);
    expect(html).toContain('Reads and searches files and the web without asking. Other tools ask first.');
    expect(html).not.toContain('data-testid="permission-level-custom"');
  });
  it('"show included tools" lists what each level resolves to here; none has no list', () => {
    const html = field('read');
    expect(html).not.toContain('data-testid="permission-tools-none"');
    const write = html.slice(html.indexOf('data-testid="permission-tools-write"'));
    expect(write.slice(0, write.indexOf('</details>'))).toContain('write_file');
    const read = html.slice(html.indexOf('data-testid="permission-tools-read"'));
    expect(read.slice(0, read.indexOf('</details>'))).not.toContain('write_file');
  });
  it('a warning only for elevated and all', () => {
    expect(field('read')).not.toContain('data-testid="permission-warning"');
    expect(field('write')).not.toContain('data-testid="permission-warning"');
    expect(field('elevated')).toContain('run commands and send messages');
    expect(field('all')).toContain('every MCP server included');
  });
  it('the "ask me every time" switch reflects the approval mode', () => {
    expect(field('read')).toMatch(/role="switch" aria-checked="false"[^>]*data-testid="permission-always"/);
    expect(field('read', 'always')).toMatch(/role="switch" aria-checked="true"[^>]*data-testid="permission-always"/);
    expect(field('read')).toContain('Ask me every time it uses a tool');
  });
  it('"pick tools yourself" is folded, holds the chip editor, and is open while custom is in use', () => {
    const closed = field('read');
    expect(closed).toMatch(/<details[^>]*data-testid="permission-custom"/);
    expect(closed).not.toMatch(/<details[^>]*open=""[^>]*data-testid="permission-custom"/);
    expect(closed).toContain('data-testid="permission-use-custom"');
    expect(closed).toContain('data-testid="chip-editor"');
    const open = field('custom');
    expect(open).toMatch(/<details[^>]*open=""[^>]*data-testid="permission-custom"/);
    expect(open).not.toContain('data-testid="permission-use-custom"');
    expect(open).not.toMatch(/aria-checked="true"[^>]*data-testid="permission-level-/);
  });
  it('Korean copy', async () => {
    await i18n.changeLanguage('ko');
    try {
      const html = field('elevated', 'always');
      for (const s of ['도구 없음', '읽기만', '쓰기까지', '중요 권한', '모든 권한', '도구를 쓸 때마다 나에게 묻기', '포함된 도구 보기', '직접 고르기 (고급)']) {
        expect(html).toContain(s);
      }
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('remembered approvals in the editor (R10.7)', () => {
  it('the form carries them; the put body always sends the list (so a revoke reaches the server)', () => {
    const f = formFromParticipant(row({ permission: { level: 'read', approval: 'auto', approvedTools: ['send_message'] } }));
    expect(f.permission.approvedTools).toEqual(['send_message']);
    expect((participantPutBody(f).profile as { permission: unknown }).permission).toEqual({
      level: 'read',
      approval: 'auto',
      approvedTools: ['send_message'],
    });
    const none = participantPutBody(blankParticipantForm());
    expect((none.profile as { permission: { approvedTools: unknown } }).permission.approvedTools).toEqual([]);
    expect(withToolRefs(f, ['grep']).permission.approvedTools).toEqual(['send_message']);
  });
  it('"허용해 둔 도구" chips with × appear only when there are some', () => {
    const html = render(
      <ParticipantPermissionField
        value={{ level: 'read', approval: 'auto', approvedTools: ['send_message', 'run_command'] }}
        levels={LEVELS}
        onChange={noop}
        customEditor={null}
      />,
    );
    expect(html).toContain('data-testid="permission-approved"');
    expect(html).toContain('data-approved-tool="send_message"');
    expect(html).toContain('aria-label="Ask again for run_command"');
    expect(html).toContain('A tool you allow once is not asked again.');
    const empty = render(
      <ParticipantPermissionField value={{ level: 'read', approval: 'auto' }} levels={LEVELS} onChange={noop} customEditor={null} />,
    );
    expect(empty).not.toContain('data-testid="permission-approved"');
  });
  it('Korean copy', async () => {
    await i18n.changeLanguage('ko');
    try {
      const html = render(
        <ParticipantPermissionField
          value={{ level: 'read', approval: 'auto', approvedTools: ['send_message'] }}
          levels={LEVELS}
          onChange={noop}
          customEditor={null}
        />,
      );
      expect(html).toContain('허용해 둔 도구');
      expect(html).toContain('한 번 허용한 도구는 다시 묻지 않습니다.');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('the editor and the roster card', () => {
  it('the editor draws the permission field in the guardrails section, chips folded inside it', () => {
    const html = render(
      <ParticipantEditor initial={formFromParticipant(row({ toolRefs: ['grep'] }))} onCancel={noop} onSaved={noop} />,
    );
    const guard = html.slice(html.indexOf('data-editor-section="guardrails"'), html.indexOf('data-editor-section="external"'));
    expect(guard).toContain('data-testid="permission-field"');
    expect(guard).toContain('data-level="custom"');
    const custom = guard.slice(guard.indexOf('data-testid="permission-custom"'));
    expect(custom).toContain('grep');
    expect(custom).toContain('Type a tool name, then Enter');
  });
  it('the roster card badges the level, the risky ones in the warning colour', () => {
    const p = {
      id: 'p1',
      name: 'reader',
      displayName: 'Reader',
      description: '',
      avatar: { kind: 'emoji' as const, value: '📖' },
      color: '#0EA5E9',
    };
    const card = (permission?: { level: 'read' | 'all'; approval: 'auto' | 'always' }) =>
      render(
        <ParticipantCard
          participant={p as never}
          {...(permission ? { permission } : {})}
          busy={false}
          confirmingDelete={false}
          onEdit={noop}
          onDuplicate={noop}
          onExport={noop}
          onDelete={noop}
        />,
      );
    expect(card({ level: 'read', approval: 'always' })).toMatch(/data-testid="participant-permission" data-level="read">Read only · asks every time</);
    expect(card({ level: 'all', approval: 'auto' })).toMatch(/text-destructive" data-testid="participant-permission" data-level="all"/);
    expect(card()).not.toContain('data-testid="participant-permission"');
  });
});
