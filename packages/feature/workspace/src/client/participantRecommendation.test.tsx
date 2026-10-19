import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import type { RecommendationInfo } from '@cockpit/feature-agent';
import { ParticipantEditor } from './ParticipantEditor';
import { ParticipantSectionView } from './ParticipantSection';
import { formFromDraft, participantPutBody, validateParticipantForm } from './participantForm';
import { runRecommendationChoice, type ChoiceReply } from './recommendationChoice';
import {
  __pendingSettingsFocusForTest as pendingFocus,
  clearSettingsFocus,
  requestSettingsFocus,
  takeSettingsFocus,
} from './settingsFocus';

/**
 * multi-agent-chat MAC-M6 (§8.13) — Settings' half of naby's participant
 * recommendations: the editor opened on a `new` recommendation (prefilled from
 * its draft, naby's banner, three ways out), the requests each way out sends,
 * the `recommendation:<id>` handoff, and the "naby's participant suggestions"
 * switch. Rendered statically, like ParticipantSection.test.tsx.
 */

const render = (node: ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const noop = () => {};

const DRAFT = {
  name: 'relnotes',
  displayName: 'Release-note editor',
  description: 'Proofreads release notes before they ship.',
  instructions: 'You proofread release notes. Keep the author voice.',
  guardrailsPolicy: 'Never rewrite version numbers.',
  greeting: 'Send me the notes.',
  avatar: { kind: 'emoji' as const, value: '📝' },
  color: '#10B981',
};

const REC: RecommendationInfo = {
  id: 'rec-1',
  sessionId: 'sess-9',
  kind: 'new',
  name: DRAFT.name,
  displayName: DRAFT.displayName,
  description: DRAFT.description,
  avatar: DRAFT.avatar,
  color: DRAFT.color,
  specialty: 'release-note proofreading',
  reason: 'Release notes came up three times.',
  draft: DRAFT,
};

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => clearSettingsFocus());

describe('formFromDraft', () => {
  it('fills identity and words from the draft, with the safe defaults of a draft', () => {
    const f = formFromDraft(DRAFT);
    expect(f.id).toBeUndefined();
    expect(f).toMatchObject({
      name: 'relnotes',
      displayName: 'Release-note editor',
      description: DRAFT.description,
      avatarEmoji: '📝',
      color: '#10B981',
      instructions: DRAFT.instructions,
      greeting: DRAFT.greeting,
      policy: DRAFT.guardrailsPolicy,
      toolRefs: [],
      mcpServers: [],
      skills: [],
      model: '',
      memoryScope: 'session',
    });
    expect(validateParticipantForm(f)).toEqual([]);
    const body = participantPutBody(f);
    expect(body).toMatchObject({ action: 'participant.put', name: 'relnotes', toolRefs: [], memoryScope: 'session' });
    expect(body).not.toHaveProperty('id');
  });

  it('a bad colour falls back to a preset; an @ on the handle is dropped', () => {
    const f = formFromDraft({ ...DRAFT, name: '@relnotes', color: 'teal' });
    expect(f.name).toBe('relnotes');
    expect(f.color).toMatch(/^#/);
  });
});

describe('the editor opened on a recommendation', () => {
  const editor = (rec?: RecommendationInfo) =>
    render(<ParticipantEditor initial={formFromDraft(DRAFT)} onCancel={noop} onSaved={noop} {...(rec ? { recommendation: rec } : {})} />);

  it('is prefilled from the draft', () => {
    const html = editor(REC);
    expect(html).toContain('value="relnotes"');
    expect(html).toContain('value="Release-note editor"');
    expect(html).toContain('You proofread release notes. Keep the author voice.');
    expect(html).toContain('Never rewrite version numbers.');
    expect(html).toContain('>New participant<');
  });

  it("shows naby's banner with the reason and the three buttons, and no plain Save", () => {
    const html = editor(REC);
    expect(html).toContain('data-testid="recommendation-banner"');
    expect(html).toMatch(/data-testid="recommendation-banner-reason"[^>]*>naby&#x27;s suggestion · Release notes came up three times\./);
    expect(html).toContain('>Save and add to conversation</button>');
    expect(html).toContain('>Save only</button>');
    expect(html).toContain('>Discard</button>');
    expect(html).not.toContain('data-testid="participant-save"');
    expect(html.indexOf('recommendation-banner')).toBeLessThan(html.indexOf('data-editor-section="identity"'));
  });

  it('without a recommendation: no banner, the ordinary Save', () => {
    const html = editor();
    expect(html).not.toContain('recommendation-banner');
    expect(html).toContain('data-testid="participant-save"');
  });

  it('Korean: 나비의 추천 banner and 저장하고 대화에 추가 · 저장만 · 버리기', async () => {
    await i18n.changeLanguage('ko');
    try {
      const html = editor(REC);
      expect(html).toContain('나비의 추천 · Release notes came up three times.');
      expect(html).toContain('>저장하고 대화에 추가</button>');
      expect(html).toContain('>저장만</button>');
      expect(html).toContain('>버리기</button>');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('what each button sends (R9.3)', () => {
  function recorder(replies: Record<string, ChoiceReply> = {}) {
    const sent: Record<string, unknown>[] = [];
    const post = async (body: Record<string, unknown>): Promise<ChoiceReply> => {
      sent.push(body);
      const action = String(body.action);
      return (
        replies[action] ??
        (action === 'participant.put' ? { ok: true, participant: { id: 'p-new' }, participants: ['list'] } : { ok: true })
      );
    };
    return { sent, post };
  }
  const putBody = participantPutBody(formFromDraft(DRAFT));

  it('save and add: put → session.participants.add → accept with the new agentId', async () => {
    const { sent, post } = recorder();
    const out = await runRecommendationChoice('save-add', REC, putBody, post);
    expect(sent.map((b) => b.action)).toEqual(['participant.put', 'session.participants.add', 'session.recommendations.accept']);
    expect(sent[1]).toEqual({ action: 'session.participants.add', sessionId: 'sess-9', agentId: 'p-new' });
    expect(sent[2]).toEqual({ action: 'session.recommendations.accept', id: 'rec-1', agentId: 'p-new' });
    expect(out).toEqual({ ok: true, choice: 'save-add', participants: ['list'], agentId: 'p-new' });
  });

  it('save only: put → accept, no add', async () => {
    const { sent, post } = recorder();
    await runRecommendationChoice('save-only', REC, putBody, post);
    expect(sent.map((b) => b.action)).toEqual(['participant.put', 'session.recommendations.accept']);
  });

  it('discard: dismiss only, nothing saved', async () => {
    const { sent, post } = recorder();
    const out = await runRecommendationChoice('discard', REC, null, post);
    expect(sent).toEqual([{ action: 'session.recommendations.dismiss', id: 'rec-1' }]);
    expect(out.ok).toBe(true);
  });

  it('a refused save stops there (the recommendation stays pending); a refused add still closes it', async () => {
    const refused = recorder({ 'participant.put': { ok: false, error: "agent name 'relnotes' is already in use" } });
    const out = await runRecommendationChoice('save-add', REC, putBody, refused.post);
    expect(out).toEqual({ ok: false, stage: 'put', error: "agent name 'relnotes' is already in use" });
    expect(refused.sent.map((b) => b.action)).toEqual(['participant.put']);

    const capped = recorder({ 'session.participants.add': { ok: false, error: 'a session can hold at most 5 participants' } });
    const out2 = await runRecommendationChoice('save-add', REC, putBody, capped.post);
    expect(out2).toMatchObject({ ok: true, addError: 'a session can hold at most 5 participants' });
    expect(capped.sent.map((b) => b.action)).toEqual(['participant.put', 'session.participants.add', 'session.recommendations.accept']);
  });
});

describe('a refused close is reported (review finding 6)', () => {
  it('accept failing → acceptError, the save still stands', async () => {
    const sent: string[] = [];
    const post = async (body: Record<string, unknown>): Promise<ChoiceReply> => {
      sent.push(String(body.action));
      if (body.action === 'participant.put') return { ok: true, participant: { id: 'p-new' } };
      if (body.action === 'session.recommendations.accept') return { ok: false, error: 'the recommendation is already dismissed' };
      return { ok: true };
    };
    const out = await runRecommendationChoice('save-only', REC, participantPutBody(formFromDraft(DRAFT)), post);
    expect(out).toMatchObject({ ok: true, agentId: 'p-new', acceptError: 'the recommendation is already dismissed' });
    expect(out.ok && out.addError).toBeFalsy();
    expect(sent).toEqual(['participant.put', 'session.recommendations.accept']);
  });

  it('the editor has the copy for it in both languages', async () => {
    expect(i18n.t('participants.recommend.savedNotClosed', { error: 'x' })).toBe('Saved, but the suggestion could not be closed: x');
    await i18n.changeLanguage('ko');
    try {
      expect(i18n.t('participants.recommend.savedNotClosed', { error: 'x' })).toBe('저장했지만 추천을 닫지 못했습니다: x');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('the recommendation:<id> handoff', () => {
  it('a request nobody rendered waits; the section takes it by prefix, once', () => {
    requestSettingsFocus('recommendation:rec-1');
    expect(takeSettingsFocus('system-mcp:')).toBeUndefined();
    expect(pendingFocus()).toBe('recommendation:rec-1');
    expect(takeSettingsFocus('recommendation:')).toBe('recommendation:rec-1');
    expect(takeSettingsFocus('recommendation:')).toBeUndefined();
  });
});

describe("Settings: naby's participant suggestions switch", () => {
  const view = (over: Partial<Parameters<typeof ParticipantSectionView>[0]> = {}) =>
    render(
      <ParticipantSectionView
        participants={[]}
        models={{}}
        limits={{ maxPerSession: 5, maxSpeechesPerRound: 6, maxRoundTrips: 3 }}
        loading={false}
        busy={false}
        confirmingId={null}
        onAdd={noop}
        onImport={noop}
        onEdit={noop}
        onDuplicate={noop}
        onExport={noop}
        onDelete={noop}
        onToggleRecommendations={noop}
        {...over}
      />,
    );

  it('is in the participants section, on by default, and says what it costs', () => {
    const html = view();
    expect(html).toContain('data-testid="participant-recommendations-toggle"');
    expect(html).toMatch(/<input type="checkbox"[^>]*checked=""/);
    expect(html).toContain('naby&#x27;s participant suggestions');
    expect(html).toContain('one small model call');
  });

  it('off reads off', () => {
    const html = view({ recommendationsEnabled: false });
    expect(html).not.toMatch(/<input type="checkbox"[^>]*checked=""/);
  });

  it('Korean label: 나비의 참가자 추천', async () => {
    await i18n.changeLanguage('ko');
    try {
      expect(view()).toContain('나비의 참가자 추천');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
