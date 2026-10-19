import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { ThemeProvider } from '@cockpit/shared-ui';
import { ParticipantRoster, ParticipantRosterView } from './ParticipantRoster';
import { EMPTY_PARTICIPANTS, ParticipantsProvider, type ParticipantsContextValue } from './ParticipantsContext';
import {
  acceptExistingRecommendation,
  recommendationAnchor,
  recommendationIdFromAnchor,
  recommendationInfoFrom,
  recommendationInfosFrom,
  type RecommendationInfo,
} from './recommendations';

/**
 * multi-agent-chat MAC-M6 (§8.13) — naby's participant recommendations on the
 * roster: the wire parser, the dashed chips before `+`, the `existing` menu
 * (reason · Add to conversation · Dismiss, D16), and the chip's add flow.
 * Rendered statically, like participantUi.test.tsx.
 */

const EXISTING: RecommendationInfo = {
  id: 'r1',
  sessionId: 's1',
  kind: 'existing',
  agentId: 'a1',
  name: 'translator',
  displayName: 'Translator',
  description: 'Translates',
  avatar: { kind: 'emoji', value: '🌐' },
  color: '#0EA5E9',
  specialty: 'translation',
  reason: 'You asked for four translations.',
};
const NEW: RecommendationInfo = {
  id: 'r2',
  sessionId: 's1',
  kind: 'new',
  name: 'relnotes',
  displayName: 'Release-note editor',
  description: 'Proofreads release notes',
  avatar: { kind: 'emoji', value: '📝' },
  color: '#10B981',
  specialty: 'release-note proofreading',
  reason: 'Release notes came up three times.',
  draft: {
    name: 'relnotes',
    displayName: 'Release-note editor',
    description: 'Proofreads release notes',
    instructions: 'You proofread.',
    guardrailsPolicy: '',
    greeting: '',
    avatar: { kind: 'emoji', value: '📝' },
    color: '#10B981',
  },
};

const render = (node: ReactNode, value?: ParticipantsContextValue) =>
  renderToStaticMarkup(
    <ThemeProvider>
      <I18nextProvider i18n={i18n}>
        <ParticipantsProvider value={value ?? EMPTY_PARTICIPANTS}>{node}</ParticipantsProvider>
      </I18nextProvider>
    </ThemeProvider>,
  );
const noop = () => {};

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('reading recommendations off the wire', () => {
  it('an existing row takes its look from the participant; a new row from its draft', () => {
    const rows = recommendationInfosFrom([
      {
        id: 'r1',
        sessionId: 's1',
        kind: 'existing',
        agentId: 'a1',
        agent: { id: 'a1', name: 'translator', description: 'Translates', profile: { displayName: 'Translator', avatar: { kind: 'emoji', value: '🌐' }, color: '#0EA5E9' } },
        specialty: 'translation',
        reason: 'r',
      },
      { id: 'r2', sessionId: 's1', kind: 'new', draft: NEW.draft, specialty: 'proofreading', reason: 'r' },
      { id: 'r3', sessionId: 's1', kind: 'existing', specialty: 'x', reason: 'no agent' },
      { id: 'r4', sessionId: 's1', kind: 'new', draft: { displayName: 'no handle' }, specialty: 'x', reason: 'r' },
      { id: 'r5', sessionId: 's1', kind: 'existing', agent: { id: 'a', name: 'a' }, specialty: '', reason: 'no specialty' },
      'garbage',
    ]);
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(rows[0]).toMatchObject({ kind: 'existing', agentId: 'a1', displayName: 'Translator', avatar: { value: '🌐' } });
    expect(rows[1]).toMatchObject({ kind: 'new', name: 'relnotes', displayName: 'Release-note editor', draft: { instructions: 'You proofread.' } });
    expect(recommendationInfoFrom(null)).toBeNull();
  });

  it('the Settings anchor round-trips', () => {
    expect(recommendationAnchor('abc')).toBe('recommendation:abc');
    expect(recommendationIdFromAnchor('recommendation:abc')).toBe('abc');
    expect(recommendationIdFromAnchor('system-mcp:skill-hub')).toBeNull();
    expect(recommendationIdFromAnchor('recommendation:')).toBeNull();
  });
});

describe('roster recommendation chips (R9.3)', () => {
  const view = (over: Partial<Parameters<typeof ParticipantRosterView>[0]> = {}) =>
    render(
      <ParticipantRosterView
        hubLabel="naby"
        inSession={[]}
        addable={[]}
        speakingId={null}
        maxPerSession={5}
        hasSession
        menuOpen={false}
        onToggleMenu={noop}
        onAdd={noop}
        onRemove={noop}
        recommendations={[EXISTING, NEW]}
        {...over}
      />,
    );

  it('a dashed chip, before the +, with avatar, name and a Suggested badge', () => {
    const html = view({ recommendations: [EXISTING] });
    expect(html).toContain('data-roster-recommendation="r1"');
    expect(html).toMatch(/border-dashed border-brand\/60/);
    expect(html).toContain('>Translator<');
    expect(html.match(/>Suggested</g)).toHaveLength(1);
    expect(html).not.toContain('roster-recommendation-more');
    expect(html.indexOf('data-roster-recommendation="r1"')).toBeLessThan(html.indexOf('data-testid="roster-add"'));
    expect(html.indexOf('data-roster-id="naby"')).toBeLessThan(html.indexOf('data-roster-recommendation="r1"'));
  });

  it('one chip at most; the rest fold into a "+N suggested" pill (review finding 10)', () => {
    const html = view();
    expect(html).toContain('data-roster-recommendation="r1"');
    expect(html).not.toContain('data-roster-recommendation="r2"');
    expect(html).toMatch(/data-testid="roster-recommendation-more"[^>]*>\+1 suggested</);
    expect(html.indexOf('roster-recommendation-more')).toBeLessThan(html.indexOf('data-testid="roster-add"'));
    expect(html).not.toContain('data-testid="roster-recommendation-list"');
  });

  it('the pill opens every pending recommendation: Add for an existing one, Review in Settings for a draft', () => {
    const html = view({ openRecommendationId: '__recommendations__' });
    expect(html).toContain('data-testid="roster-recommendation-list"');
    expect(html).toContain('data-recommendation-row="r1"');
    expect(html).toContain('data-recommendation-row="r2"');
    expect(html).toContain('>Add to conversation</button>');
    expect(html).toContain('>Review in Settings</button>');
    expect(html.match(/>Dismiss<\/button>/g)).toHaveLength(2);
    expect(html).toContain('Release notes came up three times.');
  });

  it('Korean pill: +1 추천', async () => {
    await i18n.changeLanguage('ko');
    try {
      expect(view()).toContain('>+1 추천<');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('hover shows naby\'s reason (title); no menu until clicked', () => {
    const html = view({ recommendations: [EXISTING] });
    expect(html).toContain("naby&#x27;s suggestion · You asked for four translations.");
    expect(html).not.toContain('data-testid="roster-recommendation-menu"');
  });

  it('an open existing chip: the reason, Add to conversation and Dismiss', () => {
    const html = view({ openRecommendationId: 'r1' });
    expect(html).toContain('data-testid="roster-recommendation-menu"');
    expect(html).toMatch(/data-testid="roster-recommendation-reason"[^>]*>naby&#x27;s suggestion · You asked for four translations\./);
    expect(html).toContain('>Add to conversation</button>');
    expect(html).toContain('>Dismiss</button>');
  });

  it('a new chip never opens the inline menu (it goes to Settings)', () => {
    const html = view({ recommendations: [NEW], openRecommendationId: 'r2' });
    expect(html).not.toContain('data-testid="roster-recommendation-menu"');
  });

  it('at the cap the add button is inert', () => {
    const html = view({ openRecommendationId: 'r1', maxPerSession: 0 });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="roster-recommendation-accept"/);
  });

  it('Korean: 추천 badge, 대화에 추가 · 무시', async () => {
    await i18n.changeLanguage('ko');
    try {
      const html = view({ openRecommendationId: 'r1' });
      expect(html).toContain('>추천<');
      expect(html).toContain('나비의 추천 · You asked for four translations.');
      expect(html).toContain('>대화에 추가</button>');
      expect(html).toContain('>무시</button>');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('the wired roster reads the chips from the chat context', () => {
    const html = render(<ParticipantRoster speakingId={null} />, {
      ...EMPTY_PARTICIPANTS,
      sessionId: 's1',
      recommendations: [NEW],
    });
    expect(html).toContain('data-roster-recommendation="r2"');
    expect(html).toContain('data-recommendation-kind="new"');
  });
});

describe('Add to conversation from the chip (D16)', () => {
  it('adds the participant, then accepts the recommendation', async () => {
    const calls: string[] = [];
    const out = await acceptExistingRecommendation(EXISTING, {
      add: async (id) => {
        calls.push(`add:${id}`);
        return { ok: true };
      },
      accept: async (id) => {
        calls.push(`accept:${id}`);
        return { ok: true, recommendations: [] };
      },
    });
    expect(calls).toEqual(['add:a1', 'accept:r1']);
    expect(out).toEqual({ reply: { ok: true }, recommendations: [] });
  });

  it('a failed add (the cap) leaves it pending: no accept', async () => {
    const calls: string[] = [];
    const out = await acceptExistingRecommendation(EXISTING, {
      add: async () => ({ ok: false, error: 'a session can hold at most 5 participants' }),
      accept: async (id) => {
        calls.push(id);
        return { ok: true };
      },
    });
    expect(calls).toEqual([]);
    expect(out.reply).toEqual({ ok: false, error: 'a session can hold at most 5 participants' });
  });

  it('a new recommendation is never accepted from the chip', async () => {
    const out = await acceptExistingRecommendation(NEW, {
      add: async () => ({ ok: true }),
      accept: async () => ({ ok: true }),
    });
    expect(out.reply.ok).toBe(false);
  });
});
