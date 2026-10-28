import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { ThemeProvider } from '@cockpit/shared-ui';
import { ParticipantRoster, ParticipantRosterView, ShowRoutingToggleView } from './ParticipantRoster';
import { MessageList } from './MessageList';
import { RoutingChip } from './RoutingChip';
import { ParticipantProposalCard, ProposalOutcomeLine } from './ToolApprovalPrompt';
import { MessageBubble } from './MessageBubble';
import { RoundProgressStrip } from './RoundProgressStrip';
import { EMPTY_PARTICIPANTS, ParticipantsProvider, type ParticipantsContextValue } from './ParticipantsContext';
import type { ParticipantInfo } from './participants';
import type { ChatMessage } from './types';

/**
 * multi-agent-chat MAC-M3 — the participant UI, rendered statically (there is no
 * DOM harness in this repo; see NabyMcpOAuth.test.tsx). These pin WHAT each
 * surface draws in each state; the rules behind them are in participants.test.ts.
 */

const P = (id: string, name: string, displayName: string, extra: Partial<ParticipantInfo> = {}): ParticipantInfo => ({
  id,
  name,
  displayName,
  description: `${displayName} helps`,
  avatar: { kind: 'emoji', value: '🌐' },
  color: '#0EA5E9',
  ...extra,
});

const TRANSLATOR = P('a1', 'translator', 'Translator');
const REVIEWER = P('a2', 'reviewer', 'Reviewer', { avatar: { kind: 'emoji', value: '🔍' }, color: '#10B981' });

function ctx(over: Partial<ParticipantsContextValue> = {}): ParticipantsContextValue {
  const registered = over.registered ?? [TRANSLATOR, REVIEWER];
  return {
    ...EMPTY_PARTICIPANTS,
    enabled: true,
    sessionId: 'sess-1',
    hub: { id: 'naby-id', name: 'naby' },
    registered,
    inSession: [TRANSLATOR],
    lookup: (id: string, name?: string) => registered.find((p) => p.id === id || (!!name && p.name === name)),
    ...over,
  };
}

const render = (node: ReactNode, value: ParticipantsContextValue = ctx()) =>
  renderToStaticMarkup(
    <ThemeProvider>
      <I18nextProvider i18n={i18n}>
        <ParticipantsProvider value={value}>{node}</ParticipantsProvider>
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

describe('ParticipantRosterView (R6.2)', () => {
  const view = (over: Partial<Parameters<typeof ParticipantRosterView>[0]> = {}) =>
    render(
      <ParticipantRosterView
        hubLabel="naby"
        inSession={[TRANSLATOR]}
        addable={[REVIEWER]}
        speakingId={null}
        maxPerSession={5}
        hasSession
        menuOpen={false}
        onToggleMenu={noop}
        onAdd={noop}
        onRemove={noop}
        {...over}
      />,
    );

  it('puts naby first, pinned, with no remove button', () => {
    const html = view();
    const nabyAt = html.indexOf('data-roster-id="naby"');
    const trAt = html.indexOf('data-roster-id="a1"');
    expect(nabyAt).toBeGreaterThan(-1);
    expect(trAt).toBeGreaterThan(nabyAt);
    expect(html).toContain('pinned');
    expect(html).not.toContain('roster-remove-naby');
    expect(html).toContain('roster-remove-translator');
  });

  it('marks the speaking participant and shrinks the others to their avatar', () => {
    const html = view({ inSession: [TRANSLATOR, REVIEWER], speakingId: 'a2' });
    expect(html).toMatch(/data-roster-id="a2"[^>]*data-speaking="true"/);
    expect(html).toContain('participant-speaking');
    // The idle translator shows no name while the reviewer speaks.
    const chip = html.slice(html.indexOf('data-roster-id="a1"'), html.indexOf('data-roster-id="a2"'));
    expect(chip).not.toContain('Translator</span>');
  });

  it('folds idle participants past four into +N', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((x) => P(x, x, x.toUpperCase()));
    const html = view({ inSession: five, addable: [] });
    expect(html).toContain('data-testid="roster-folded"');
    expect(html).toContain('+1');
    expect(html).not.toContain('data-roster-id="e"');
  });

  it('the + menu lists the registered participants not here, with n/max', () => {
    const html = view({ menuOpen: true });
    expect(html).toContain('data-testid="roster-menu"');
    expect(html).toContain('Participants 1/5');
    expect(html).toContain('data-addable="reviewer"');
    expect(html).not.toContain('data-addable="translator"');
    expect(html).toMatch(/data-testid="roster-add-reviewer"(?![^>]*disabled)/);
  });

  it('at the cap the menu says so and its Add buttons are disabled', () => {
    const html = view({ menuOpen: true, maxPerSession: 1 });
    expect(html).toContain('data-testid="roster-cap"');
    expect(html).toContain('limit of 1 participants');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="roster-add-reviewer"/);
  });

  it('MAC-M3b: with zero participants the roster still shows naby (with its avatar) and the + button', () => {
    const html = view({ inSession: [], addable: [] });
    expect(html).toContain('data-testid="participant-roster"');
    expect(html).toContain('data-roster-id="naby"');
    expect(html).toContain('data-naby-avatar');
    expect(html).toContain('data-testid="roster-add"');
    // Nobody else, and nothing folded.
    expect(html.match(/data-roster-id=/g)).toHaveLength(1);
    expect(html).not.toContain('roster-folded');
  });

  it('MAC-M3b: the wired roster renders even when the chat has no participants at all', () => {
    // EMPTY_PARTICIPANTS is `enabled:false` — the context a naby-only chat has
    // when nothing is registered. It used to render nothing.
    const html = render(<ParticipantRoster speakingId={null} />, EMPTY_PARTICIPANTS);
    expect(html).toContain('data-roster-id="naby"');
    expect(html).toContain('data-naby-avatar');
    expect(html).toContain('data-testid="roster-add"');
    // The "show routing" toggle still waits for participants.
    expect(render(<ShowRoutingToggleView on={false} onToggle={noop} />)).toContain('show-routing-toggle');
  });

  it('before the first send nothing can be added', () => {
    const html = view({ menuOpen: true, hasSession: false });
    expect(html).toContain('Send a first message');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="roster-add-reviewer"/);
    expect(html).not.toContain('roster-remove-translator');
  });
});

describe('ShowRoutingToggleView', () => {
  it('reflects its state', () => {
    expect(render(<ShowRoutingToggleView on={false} onToggle={noop} />)).toContain('aria-pressed="false"');
    expect(render(<ShowRoutingToggleView on onToggle={noop} />)).toContain('aria-pressed="true"');
  });
});

describe('RoutingChip visibility (R6.4)', () => {
  const delegate = { kind: 'delegate' as const, targetAgentId: 'a1', targetName: 'translator', decision: 'route' as const, reason: 'needs English', brief: 'Translate the notes' };

  it('a hand-off is hidden by default', () => {
    expect(render(<RoutingChip routing={delegate} />)).toBe('');
  });

  it('"show routing" draws it as a chip with its reason and collapsed brief', () => {
    const html = render(<RoutingChip routing={delegate} />, ctx({ settings: { ...ctx().settings, showRouting: true } }));
    expect(html).toContain('data-testid="routing-chip"');
    expect(html).toContain('naby → @translator');
    // MAC-M3b: naby's own step is marked with naby's avatar.
    expect(html).toContain('data-naby-avatar');
    expect(html).toContain('needs English');
    expect(html).toContain('<details');
    expect(html).toContain('Translate the notes');
  });

  it('not-in-session and cap are system lines even with routing hidden', () => {
    const notIn = render(
      <RoutingChip routing={{ kind: 'delegate', targetAgentId: 'a2', targetName: 'reviewer', decision: 'not-in-session' }} />,
    );
    expect(notIn).toContain('data-routing-kind="not-in-session"');
    expect(notIn).toContain('@reviewer is not in this conversation');
    // One click adds it — it is registered and the session exists.
    expect(notIn).toContain('>Add</button>');

    const cap = render(<RoutingChip routing={{ kind: 'end', decision: 'cap', reason: 'roundTrips' }} />);
    expect(cap).toContain('data-routing-kind="cap"');
    expect(cap).toContain('round-trip limit (3)');
  });

  it("MAC-M4: a cap line uses the event's own limit, and a routed chip shows the routing call's tokens", () => {
    const cap = render(<RoutingChip routing={{ kind: 'end', decision: 'cap', reason: 'roundTrips', limit: 7 }} />);
    expect(cap).toContain('round-trip limit (7)');
    const on = ctx({ settings: { ...ctx().settings, showRouting: true } });
    expect(render(<RoutingChip routing={{ ...delegate, tokens: { input: 1200, output: 34 } }} />, on)).toContain('1234 tok');
    expect(render(<RoutingChip routing={{ ...delegate, tokens: { input: 0, output: 0 } }} />, on)).not.toContain('routing-tokens');
  });

  it('R3.10: a blocked line-start hand-off is a system line naming the participant, for both limits', async () => {
    const speeches = {
      kind: 'end' as const,
      decision: 'cap' as const,
      reason: 'speeches',
      limit: 6,
      blocked: { by: 'hub-mention' as const, cap: 'speeches' as const, limit: 6, agentId: 'a2', name: 'aside' },
    };
    const trips = {
      kind: 'end' as const,
      reason: 'roundTrips',
      blocked: { by: 'hub-mention' as const, cap: 'roundTrips' as const, limit: 3, agentId: 'a2', name: 'aside' },
    };
    // Visible with routing hidden (it is something the user must be told).
    const a = render(<RoutingChip routing={speeches} />);
    expect(a).toContain('data-routing-kind="cap"');
    expect(a).toContain('Reached the speech limit (6) — couldn’t hand this to @aside.');
    expect(a).not.toContain('naby wraps up');
    // The reloaded shape: no `decision`, only the stored `blocked`.
    const b = render(<RoutingChip routing={trips} />);
    expect(b).toContain('data-routing-kind="cap"');
    expect(b).toContain('Reached the round-trip limit with @aside (3) — couldn’t hand this over.');
    await i18n.changeLanguage('ko');
    try {
      expect(render(<RoutingChip routing={speeches} />)).toContain('발언 상한(6)에 걸려 @aside에게 넘기지 못했습니다.');
      expect(render(<RoutingChip routing={trips} />)).toContain('왕복 상한(3)에 걸려 @aside에게 넘기지 못했습니다.');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('an ignored participant-to-participant mention only shows with routing on', () => {
    const r = { kind: 'end' as const, decision: 'ignored-mention' as const, targetName: 'reviewer' };
    expect(render(<RoutingChip routing={r} />)).toBe('');
    expect(render(<RoutingChip routing={r} />, ctx({ settings: { ...ctx().settings, showRouting: true } }))).toContain(
      '@reviewer mention ignored',
    );
  });
});

describe('ParticipantProposalCard (R6.7)', () => {
  const proposal = {
    agentId: 'a2',
    name: 'reviewer',
    displayName: 'Reviewer',
    avatar: { kind: 'emoji' as const, value: '🔍' },
    color: '#10B981',
    description: 'Reviews pull requests',
    reason: 'The user asked for a review',
  };

  it('shows the participant, naby’s reason, and only Approve / Decline', () => {
    const html = render(<ParticipantProposalCard proposal={proposal} busy={false} more={0} onApprove={noop} onDecline={noop} />);
    expect(html).toContain('data-testid="participant-proposal"');
    // MAC-M3b: the title chip carries naby's avatar, not a 🦋 in the string.
    expect(html).toContain('data-naby-avatar');
    expect(html).toContain('naby’s proposal · needs your OK');
    expect(html).not.toContain('🦋');
    expect(html).toContain('Reviewer looks right for this');
    expect(html).toContain('@reviewer');
    expect(html).toContain('Reviews pull requests');
    expect(html).toContain('The user asked for a review');
    expect(html).toContain('data-testid="proposal-approve"');
    expect(html).toContain('data-testid="proposal-decline"');
    expect(html).not.toContain('Always');
  });

  it('a decline says naby will not propose it again in this session', () => {
    const html = render(
      <ProposalOutcomeLine outcome={{ approvalId: 'x', displayName: 'Reviewer', decision: 'deny' }} onDismiss={noop} />,
    );
    expect(html).toContain('data-decision="deny"');
    expect(html).toContain('won’t propose Reviewer again in this session');
  });

  it('reads in Korean too', async () => {
    await i18n.changeLanguage('ko');
    try {
      const html = render(
        <ProposalOutcomeLine outcome={{ approvalId: 'x', displayName: '리뷰어', decision: 'deny' }} onDismiss={noop} />,
      );
      expect(html).toContain('같은 세션에서');
      expect(html).toContain('다시 제안하지 않아요');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('MessageBubble speaker card (R6.1)', () => {
  const bubble = (message: ChatMessage, relayed = false, value = ctx()) =>
    render(<MessageBubble message={message} relayed={relayed} />, value);

  it('a participant’s bubble carries its avatar, name, handle and colour', () => {
    const html = bubble(
      { id: 'm1', role: 'assistant', content: 'Here is the translation', speaker: { agentId: 'a1', name: 'translator' } },
      true,
    );
    expect(html).toContain('data-speaker="translator"');
    expect(html).toContain('data-participant-avatar');
    expect(html).toContain('Translator');
    expect(html).toContain('@translator');
    expect(html).toContain('bg-card');
    expect(html).toContain('border-left:3px solid #0EA5E9');
    expect(html).toContain('data-testid="relay-chip"');
    expect(html).toContain('↪ via naby');
  });

  it('no relay chip when naby did not hand it over', () => {
    const html = bubble({ id: 'm1', role: 'assistant', content: 'x', speaker: { agentId: 'a1', name: 'translator' } });
    expect(html).not.toContain('relay-chip');
  });

  it('MAC-M3b: naby’s own reply is a card with naby’s avatar and brand-coloured name', () => {
    const html = bubble({ id: 'm2', role: 'assistant', content: 'naby answers' });
    expect(html).toContain('data-speaker="naby"');
    expect(html).toContain('data-naby-avatar');
    expect(html).toContain('aria-label="나비"');
    expect(html).toMatch(/data-testid="naby-line"[^>]*><span class="text-brand">naby<\/span>/);
    // The card: the agent card's surface, edged in the brand colour.
    expect(html).toContain('bg-card text-card-foreground border border-border rounded-xl');
    expect(html).toContain('border-l-brand/70');
    expect(html).toContain('naby answers');
    // Not a participant.
    expect(html).not.toContain('data-participant-avatar');
    expect(html).not.toContain('data-testid="speaker-line"');
  });

  it('MAC-M3b: naby’s card reads 나비 in Korean', async () => {
    await i18n.changeLanguage('ko');
    try {
      const html = bubble({ id: 'm2', role: 'assistant', content: '안녕하세요' });
      expect(html).toMatch(/data-testid="naby-line"[^>]*><span class="text-brand">나비<\/span>/);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('MAC-M3b: an assistant row with nothing in it yet draws no naby header', () => {
    const html = bubble({ id: 'm3', role: 'assistant', content: '', isStreaming: true });
    expect(html).not.toContain('data-naby-avatar');
    expect(html).not.toContain('naby-line');
  });

  it('MAC-M3b: user bubbles are unchanged — no avatar, no naby line', () => {
    const html = bubble({ id: 'u1', role: 'user', content: 'hello' });
    expect(html).toContain('bg-user-bubble');
    expect(html).not.toContain('data-naby-avatar');
    expect(html).not.toContain('naby-line');
  });

  it('a routing marker row is a chip — hidden by default, drawn with "show routing"', () => {
    const row = {
      id: 'routing-1',
      role: 'system',
      content: 'naby → @translator',
      systemEvent: { kind: 'meta', detail: 'brief' },
      routing: { kind: 'delegate', targetAgentId: 'a1', targetName: 'translator' },
    } as ChatMessage;
    const hidden = bubble(row);
    expect(hidden).toBe('');
    const shown = bubble(row, false, ctx({ settings: { ...ctx().settings, showRouting: true } }));
    expect(shown).toContain('data-testid="routing-chip"');
    // Not the muted meta pill any more.
    expect(shown).not.toContain('rounded-full px-3 py-1 hover:bg-secondary');
  });
});

describe('RoundProgressStrip (R6.5)', () => {
  it('names the speaker, the next one and the speech count, with one Stop', () => {
    const html = render(
      <RoundProgressStrip
        progress={{ speech: 2, next: { agentId: 'a2', name: 'reviewer' } }}
        acting={{ name: 'translator', persona: false, participant: true, id: 'a1', avatar: { kind: 'emoji', value: '🌐' }, color: '#0EA5E9' }}
        speakerName="Translator"
        next={REVIEWER}
        maxSpeeches={6}
        onStop={noop}
      />,
    );
    expect(html).toContain('Translator is speaking');
    expect(html).toContain('@Reviewer');
    expect(html).toContain('speech 2/6');
    expect(html).toContain('data-testid="round-stop"');
    expect(html).toContain('>Stop</button>');
  });
});

describe('loading bubble (MAC-M3b)', () => {
  const list = (over: Record<string, unknown>) =>
    render(<MessageList messages={[]} isLoading thinkingName="naby" {...over} />);

  it('shows naby’s avatar when naby is the acting agent', () => {
    const html = list({ thinkingPersona: true });
    expect(html).toContain('data-naby-avatar');
    expect(html).toContain('participant-speaking');
  });

  it('a participant’s turn shows the participant’s avatar instead', () => {
    const html = list({ thinkingPersona: false, thinkingAvatar: { avatar: { kind: 'emoji', value: '🌐' }, color: '#0EA5E9' } });
    expect(html).toContain('data-participant-avatar');
    expect(html).not.toContain('data-naby-avatar');
  });

  it('no agent identity keeps the spinner', () => {
    const html = list({ thinkingPersona: false });
    expect(html).not.toContain('data-naby-avatar');
    expect(html).toContain('animate-spin');
  });
});
