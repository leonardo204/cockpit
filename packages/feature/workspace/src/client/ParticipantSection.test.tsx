import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import type { ParticipantInfo } from '@cockpit/feature-agent';
import { ParticipantSectionView } from './ParticipantSection';
import { ParticipantEditor } from './ParticipantEditor';
import { blankParticipantForm } from './participantForm';

/**
 * multi-agent-chat MAC-M3 — Settings › naby › Participants (R5.1, R5.2),
 * rendered statically: the list cards and the seven-section editor.
 */

const render = (node: ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const noop = () => {};

const TR: ParticipantInfo = {
  id: 'a1',
  name: 'translator',
  displayName: 'Translator',
  description: 'Translates release notes',
  avatar: { kind: 'emoji', value: '🌐' },
  color: '#0EA5E9',
  activeSessions: 2,
};

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('ParticipantSectionView', () => {
  const view = (over: Partial<Parameters<typeof ParticipantSectionView>[0]> = {}) =>
    render(
      <ParticipantSectionView
        participants={[TR]}
        models={{ a1: 'sonnet' }}
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
        {...over}
      />,
    );

  it('a card shows avatar, name, handle, description, session count and a Participant badge', () => {
    const html = view();
    expect(html).toContain('data-participant-card="translator"');
    expect(html).toContain('data-participant-avatar');
    expect(html).toContain('Translator');
    expect(html).toContain('@translator');
    expect(html).toContain('Translates release notes');
    expect(html).toContain('In 2 sessions');
    expect(html).toContain('>Participant<');
    expect(html).not.toContain('>Custom<');
    for (const label of ['Edit', 'Duplicate', 'Export', 'Delete']) expect(html).toContain(`>${label}</button>`);
  });

  it('Add, Import and Export are live (MAC-M4) and say what they do', () => {
    const html = view();
    expect(html).toMatch(/data-testid="participant-add"(?![^>]*disabled)/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="participant-import"/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="participant-export"/);
    expect(html).toMatch(/<button[^>]*title="Bring in a Claude Code subagent[^"]*"[^>]*data-testid="participant-import"/);
    expect(html).toMatch(/<button[^>]*title="Download this participant[^"]*"[^>]*data-testid="participant-export"/);
    expect(html).not.toContain('MAC-M4');
  });

  it('an imported participant carries an origin badge (format · day); a hand-made one does not', () => {
    const imported: ParticipantInfo = {
      ...TR,
      id: 'a2',
      name: 'minji-kim',
      origin: { format: 'character-card-v2', importedAt: new Date(2026, 9, 16, 12).getTime(), sourceHash: 'abcdef0123456789', sourceName: 'minji.json' },
    };
    const html = view({ participants: [TR, imported] });
    expect(html.match(/data-testid="participant-origin"/g)).toHaveLength(1);
    expect(html).toContain('Character card V2 · 2026-10-16');
    expect(html).toContain('Imported from minji.json (sha256 abcdef01)');
  });

  it('shows the round limits and a two-step delete', () => {
    const html = view({ confirmingId: 'a1' });
    expect(html).toContain('5 per session');
    expect(html).toContain('6 speeches per message');
    expect(html).toContain('3 naby↔participant round trips');
    expect(html).toContain('Delete for good?');
  });

  it('an empty registry says how to start', () => {
    expect(view({ participants: [] })).toContain('No participants yet');
  });
});

describe('ParticipantEditor (R5.2)', () => {
  it('has the seven R1.1 sections in order, and the routing hint under the description', () => {
    const html = render(<ParticipantEditor initial={blankParticipantForm()} onCancel={noop} onSaved={noop} />);
    const order = ['identity', 'instructions', 'knowledge', 'guardrails', 'external', 'skills', 'model'].map((id) =>
      html.indexOf(`data-editor-section="${id}"`),
    );
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const desc = html.indexOf('Description</span>');
    const hint = html.indexOf('data-testid="description-hint"');
    expect(hint).toBeGreaterThan(desc);
    expect(html).toContain('naby reads this sentence to decide when to hand work over');
  });

  it('the Korean hint is the spec’s sentence', async () => {
    await i18n.changeLanguage('ko');
    try {
      const html = render(<ParticipantEditor initial={blankParticipantForm()} onCancel={noop} onSaved={noop} />);
      expect(html).toContain('나비가 이 문장을 보고 위임을 판단합니다');
      expect(html).toContain('정체성');
      expect(html).toContain('가드레일');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('the model picker never offers `auto` (a stored model must be real)', () => {
    const html = render(<ParticipantEditor initial={blankParticipantForm()} onCancel={noop} onSaved={noop} />);
    expect(html).not.toContain('value="auto"');
    expect(html).toContain('Follow the session model');
  });
});
