import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { ParticipantDraftCard } from './ParticipantDraftCard';
import { draftFromApproval } from './participantDraft';
import {
  PERMISSION_LEVEL_CHOICES,
  PERMISSION_LEVEL_COPY,
  permissionIsRisky,
  permissionLabel,
  permissionValueFrom,
} from './participantPermission';
import { approvalAskerFrom, approvalOffersRemember, approvalReasonLines } from './toolApprovalCopy';

/**
 * A PARTICIPANT'S PERMISSION TIER ON THE CLIENT (multi-agent-chat §8.14, MAC-M7):
 * the wire reader and the copy, the draft card naming a permission (create) and
 * showing its before → after (update), and the "ask me every time" approval
 * prompt — its reason line and no "always" buttons.
 */

const render = (node: ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const noop = () => {};
const tEn = (key: string, opts: { defaultValue: string }) => String(i18n.t(key, opts));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('permissionValueFrom / copy', () => {
  it('reads a level and an approval, defaulting approval to auto', () => {
    expect(permissionValueFrom({ level: 'read', approval: 'always' })).toEqual({ level: 'read', approval: 'always' });
    expect(permissionValueFrom({ level: 'custom' })).toEqual({ level: 'custom', approval: 'auto' });
    expect(permissionValueFrom({ level: 'root' })).toBeUndefined();
    expect(permissionValueFrom({ level: 'read', approvedTools: ['send_message', 3, ''] })).toEqual({
      level: 'read',
      approval: 'auto',
      approvedTools: ['send_message'],
    });
    expect(permissionValueFrom('read')).toBeUndefined();
    expect(permissionValueFrom(undefined)).toBeUndefined();
  });
  it('five cards in R10.1 order; elevated and all are the risky ones', () => {
    expect([...PERMISSION_LEVEL_CHOICES]).toEqual(['none', 'read', 'write', 'elevated', 'all']);
    expect(PERMISSION_LEVEL_CHOICES.filter(permissionIsRisky)).toEqual(['elevated', 'all']);
    expect(permissionIsRisky('custom')).toBe(false);
  });
  it('every level has copy in both languages; Korean UI copy ends in ~합니다', async () => {
    for (const lang of ['en', 'ko']) {
      await i18n.changeLanguage(lang);
      for (const c of Object.values(PERMISSION_LEVEL_COPY)) {
        expect(i18n.exists(c.key)).toBe(true);
        expect(i18n.exists(c.descKey)).toBe(true);
        if (lang === 'ko') expect(String(i18n.t(c.descKey))).toMatch(/니다\.$/);
      }
    }
    await i18n.changeLanguage('ko');
    expect(permissionLabel({ level: 'read', approval: 'always' }, tEn)).toBe('읽기만 · 매번 승인');
    await i18n.changeLanguage('en');
    expect(permissionLabel({ level: 'write', approval: 'auto' }, tEn)).toBe('Read and write');
  });
});

const draft = {
  action: 'create',
  name: 'reader',
  displayName: 'Reader',
  description: 'Reads the docs.',
  instructions: 'You read.',
  guardrailsPolicy: '',
  greeting: '',
  avatar: { kind: 'emoji', value: '📖' },
  color: '#0EA5E9',
  addToSession: true,
};
const createDetail = (permission?: unknown) => ({
  type: 'approval_request',
  approvalId: 's1:participant.create:tc1',
  tool_name: 'participant.create',
  source: 'participant_draft',
  session_id: 's1',
  input: { draft: { ...draft, ...(permission ? { permission } : {}) }, addToSession: true },
});

describe('the draft card and a permission (§8.12 + R10.4)', () => {
  it('create without one: the no-tools line, no permission row', () => {
    const card = draftFromApproval(createDetail())!;
    expect(card.draft.permission).toBeUndefined();
    const html = render(<ParticipantDraftCard card={card} busy={false} more={0} onAnswer={noop} />);
    expect(html).not.toContain('data-testid="draft-permission"');
    expect(html).toContain('Starts at &quot;No tools&quot;');
  });
  it('create with "read · always": the row names it', () => {
    const card = draftFromApproval(createDetail({ level: 'read', approval: 'always' }))!;
    expect(card.draft.permission).toEqual({ level: 'read', approval: 'always' });
    const html = render(<ParticipantDraftCard card={card} busy={false} more={0} onAnswer={noop} />);
    expect(html).toContain('data-testid="draft-permission"');
    expect(html).toContain('Read only · asks every time');
    expect(html).not.toContain('Starts at &quot;No tools&quot;');
  });
  it('create with "all": the row is drawn as a warning', () => {
    const card = draftFromApproval(createDetail({ level: 'all', approval: 'auto' }))!;
    const html = render(<ParticipantDraftCard card={card} busy={false} more={0} onAnswer={noop} />);
    expect(html).toMatch(/bg-destructive\/10 text-destructive"[^>]*data-testid="draft-permission"/);
    expect(html).toContain('Everything');
  });
  it('update: a permission change is shown before → after', () => {
    const detail = {
      ...createDetail({ level: 'write', approval: 'auto' }),
      tool_name: 'participant.update',
      input: {
        draft: { ...draft, action: 'update', id: 'p1', permission: { level: 'write', approval: 'auto' } },
        before: { ...draft, permission: { level: 'custom', approval: 'auto' } },
        changed: ['permission'],
        addToSession: false,
      },
    };
    const card = draftFromApproval(detail)!;
    expect(card.changed).toEqual(['permission']);
    const html = render(<ParticipantDraftCard card={card} busy={false} more={0} onAnswer={noop} />);
    expect(html).toContain('data-testid="draft-change-permission"');
    expect(html).toContain('Pick tools');
    expect(html).toContain('Read and write');
    expect(html).not.toContain('[object Object]');
  });
});

describe('the out-of-level approval prompt (R10.7)', () => {
  it('says allowing remembers it; no "always" buttons', () => {
    const a = approvalAskerFrom({ approvalId: 'x', tool_name: 'send_message', source: 'participant_outside' });
    expect(approvalOffersRemember(a)).toBe(false);
    const [line] = approvalReasonLines(a);
    expect(line && 'key' in line ? tEn(line.key, { defaultValue: line.defaultValue }) : '').toContain('will not ask again');
  });
});

describe('the "ask me every time" approval prompt (R10.2)', () => {
  it('names why it asks and offers no "always" buttons', () => {
    const a = approvalAskerFrom({ approvalId: 'x', tool_name: 'echo_note', source: 'participant_always' });
    expect(a.source).toBe('participant_always');
    expect(approvalOffersRemember(a)).toBe(false);
    expect(approvalReasonLines(a)).toEqual([
      expect.objectContaining({ key: 'toolApproval.participantAlways' }),
    ]);
  });
});
