import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { ParticipantDraftCard } from './ParticipantDraftCard';
import {
  draftEdits,
  draftFormFrom,
  draftFromApproval,
  draftResolveBody,
  draftResolvedSaved,
  participantNameError,
  validateDraftForm,
  type ParticipantDraftCard as Card,
} from './participantDraft';

/**
 * NABY'S PARTICIPANT DRAFT CARD (multi-agent-chat §8.12, R8.3, MAC-M5a): reading
 * the draft off the wire, the checks that mirror the server, the body each button
 * sends (never `remember`), the card rendered statically in both languages, and
 * the roster / Settings refresh signal.
 */

const render = (node: ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const noop = () => {};

const createDetail = {
  type: 'approval_request',
  approvalId: 's1:participant.create:tc1',
  tool_name: 'participant.create',
  source: 'participant_draft',
  session_id: 's1',
  input: {
    draft: {
      action: 'create',
      name: 'translator',
      displayName: 'Translator',
      description: 'Translates between Korean and English.',
      instructions: 'You translate faithfully.\nKeep the tone.',
      guardrailsPolicy: 'Never invent facts.',
      greeting: 'Hi, I translate.',
      avatar: { kind: 'emoji', value: '🌐' },
      color: '#0EA5E9',
      addToSession: true,
    },
    addToSession: true,
  },
};

const updateDetail = {
  ...createDetail,
  approvalId: 's1:participant.update:tc2',
  tool_name: 'participant.update',
  input: {
    draft: { ...createDetail.input.draft, action: 'update', id: 'p1', description: 'Translates three languages.', instructions: 'Three languages.' },
    before: { ...createDetail.input.draft, action: undefined },
    changed: ['description', 'instructions'],
    addToSession: false,
  },
};

describe('draftFromApproval', () => {
  it('reads a create draft', () => {
    const card = draftFromApproval(createDetail)!;
    expect(card).toMatchObject({ action: 'create', addToSession: true, changed: [] });
    expect(card.draft).toMatchObject({ name: 'translator', displayName: 'Translator', avatar: { kind: 'emoji', value: '🌐' } });
  });
  it('reads an update draft with its before and changed fields', () => {
    const card = draftFromApproval(updateDetail)!;
    expect(card).toMatchObject({ action: 'update', id: 'p1', changed: ['description', 'instructions'], addToSession: false });
    expect(card.before?.description).toBe('Translates between Korean and English.');
  });
  it('is null for a tool approval and for a proposal', () => {
    expect(draftFromApproval({ approvalId: 'x', tool_name: 'Bash', input: {} })).toBeNull();
    expect(draftFromApproval({ approvalId: 'x', tool_name: 'participant.add', source: 'participant_proposal', input: {} })).toBeNull();
    expect(draftFromApproval({ ...createDetail, input: {} })).toBeNull();
  });
});

describe('client checks mirror the server', () => {
  const card = draftFromApproval(createDetail)!;
  it('the handle rule is the editor’s', () => {
    expect(participantNameError('ok-name')).toBeNull();
    expect(participantNameError('@ok')).toBeNull();
    expect(participantNameError('two words')).toBe('nameSpace');
    expect(participantNameError('a@b')).toBe('nameAt');
    expect(participantNameError('.hidden')).toBe('nameLead');
    expect(participantNameError('  ')).toBe('name');
  });
  it('display name, description, avatar and colour', () => {
    const f = draftFormFrom(card);
    expect(validateDraftForm(f, card)).toEqual([]);
    const codes = (over: Partial<typeof f>) => validateDraftForm({ ...f, ...over }, card).map((e) => e.code);
    expect(codes({ displayName: ' ' })).toEqual(['displayName']);
    expect(codes({ displayName: 'n'.repeat(81) })).toEqual(['displayNameLong']);
    expect(codes({ description: 'd'.repeat(1001) })).toEqual(['descriptionLong']);
    expect(codes({ avatar: '' })).toEqual(['avatar']);
    expect(codes({ avatar: '😀'.repeat(17) })).toEqual(['avatarLong']);
    expect(codes({ color: 'red' })).toEqual(['color']);
  });
});

describe('what each button sends (R8.3)', () => {
  const card = draftFromApproval(createDetail)!;
  const f = draftFormFrom(card);
  it('"create and add" / "create only" set addToSession and carry only changed fields', () => {
    expect(draftResolveBody('a', card, f, 'create-add')).toEqual({ approvalId: 'a', decision: 'allow', addToSession: true });
    expect(draftResolveBody('a', card, { ...f, name: '@tr', displayName: '번역가 ' }, 'create-only')).toEqual({
      approvalId: 'a',
      decision: 'allow',
      edits: { name: 'tr', displayName: '번역가' },
      addToSession: false,
    });
  });
  it('"decline" is a plain deny', () => {
    expect(draftResolveBody('a', card, f, 'decline')).toEqual({ approvalId: 'a', decision: 'deny' });
  });
  it('never asks to remember', () => {
    for (const choice of ['create-add', 'create-only', 'apply', 'decline'] as const) {
      expect(draftResolveBody('a', card, f, choice)).not.toHaveProperty('remember');
    }
  });
  it('an update keeps the draft’s own session choice', () => {
    const u = draftFromApproval(updateDetail)!;
    expect(draftResolveBody('b', u, draftFormFrom(u), 'apply')).toEqual({ approvalId: 'b', decision: 'allow', addToSession: false });
  });
  it('edits are only what differs', () => {
    expect(draftEdits(card, { ...f, avatar: '🧪', color: '#10B981' })).toEqual({ avatar: '🧪', color: '#10B981' });
  });
});

describe('ParticipantDraftCard', () => {
  it('create: editable identity, folded instructions / policy / greeting, three buttons', () => {
    const html = render(<ParticipantDraftCard card={draftFromApproval(createDetail)!} busy={false} more={0} onAnswer={noop} />);
    expect(html).toContain('data-testid="participant-draft"');
    expect(html).toContain('data-action="create"');
    for (const id of ['draft-avatar', 'draft-display-name', 'draft-name', 'draft-description']) {
      expect(html).toMatch(new RegExp(`<(input|textarea)[^>]*data-testid="${id}"`));
    }
    expect(html).toContain('value="translator"');
    expect(html).toContain('value="Translator"');
    for (const id of ['draft-instructions', 'draft-policy', 'draft-greeting']) {
      expect(html).toMatch(new RegExp(`<details[^>]*data-testid="${id}"`));
    }
    for (const id of ['draft-decline', 'draft-create-only', 'draft-create-add']) expect(html).toContain(`data-testid="${id}"`);
    expect(html).not.toContain('data-testid="draft-apply"');
    expect(html).not.toMatch(/Always allow/);
    expect(html).toContain('Create and add to this chat');
    expect(html).toContain('Starts with no tools');
  });

  it('update: only the changed fields before → after, and apply / decline', () => {
    const html = render(<ParticipantDraftCard card={draftFromApproval(updateDetail)!} busy={false} more={0} onAnswer={noop} />);
    expect(html).toContain('data-action="update"');
    expect(html).toContain('data-testid="draft-change-description"');
    expect(html).toContain('data-testid="draft-change-instructions"');
    expect(html).not.toContain('data-testid="draft-change-greeting"');
    expect(html).toContain('Translates between Korean and English.');
    expect(html).toContain('Translates three languages.');
    expect(html).toContain('data-testid="draft-apply"');
    expect(html).toContain('data-testid="draft-decline"');
    expect(html).not.toContain('data-testid="draft-create-add"');
    expect(html).toContain('Apply these changes to @translator?');
  });

  it('an invalid draft disables the approving buttons, not the decline', () => {
    const bad = { ...createDetail, input: { ...createDetail.input, draft: { ...createDetail.input.draft, name: 'two words' } } };
    const html = render(<ParticipantDraftCard card={draftFromApproval(bad)! as Card} busy={false} more={0} onAnswer={noop} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="draft-create-add"/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="draft-decline"/);
    expect(html).toContain('data-testid="draft-error-name"');
  });

  describe('in Korean', () => {
    beforeAll(async () => {
      await i18n.changeLanguage('ko');
    });
    afterAll(async () => {
      await i18n.changeLanguage('en');
    });
    it('uses the ko copy', () => {
      const html = render(<ParticipantDraftCard card={draftFromApproval(createDetail)!} busy={false} more={1} onAnswer={noop} />);
      expect(html).toContain('나비의 초안 · 승인 필요');
      expect(html).toContain('만들고 대화에 추가');
      expect(html).toContain('만들기만');
      expect(html).toContain('거절');
      const u = render(<ParticipantDraftCard card={draftFromApproval(updateDetail)!} busy={false} more={0} onAnswer={noop} />);
      expect(u).toContain('적용');
      expect(u).toContain('@translator 참가자를 이렇게 고치겠습니까?');
    });
  });
});

describe('roster / Settings refresh after a draft (R8.4)', () => {
  it('a saved draft changes the registry; a declined one or a tool approval does not', () => {
    const base = { approvalId: 'x', source: 'participant_draft', tool_name: 'participant.create', decision: 'allow', agentId: 'p9' };
    expect(draftResolvedSaved(base)).toBe(true);
    expect(draftResolvedSaved({ ...base, tool_name: 'participant.update' })).toBe(true);
    expect(draftResolvedSaved({ ...base, decision: 'deny' })).toBe(false);
    expect(draftResolvedSaved({ ...base, agentId: undefined })).toBe(false);
    expect(draftResolvedSaved({ approvalId: 'x', decision: 'allow' })).toBe(false);
  });

  it('the chat re-reads its participants on every resolved approval and announces a saved draft', () => {
    const src = readFileSync(join(__dirname, 'ParticipantsContext.tsx'), 'utf8');
    expect(src).toContain("window.addEventListener('naby:approval_resolved', onResolved);");
    expect(src).toContain('if (d && draftResolvedSaved(d) && d.session_id === sessionRef.current) {');
  });

  it('the approval prompt draws the draft card ahead of the proposal and tool cards', () => {
    const src = readFileSync(join(__dirname, 'ToolApprovalPrompt.tsx'), 'utf8');
    const draft = src.indexOf('if (current.draft) {');
    const proposal = src.indexOf('if (current.proposal) {\n    return (');
    expect(draft).toBeGreaterThan(0);
    expect(proposal).toBeGreaterThan(draft);
  });
});
