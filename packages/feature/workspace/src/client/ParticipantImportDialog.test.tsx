import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import {
  ParticipantImportPicker,
  ParticipantImportPreview,
  importFormatLabel,
  importProblemText,
  localDay,
  originBadgeText,
  type ImportWire,
} from './ParticipantImportDialog';

/**
 * multi-agent-chat MAC-M4 — the import preview (R5.3, agent-import-adapters §2):
 * the safety badges, the editable decisions, the mapping table and the LOSS
 * REPORT, rendered statically.
 */

const render = (node: ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const noop = () => {};

const PLAN: ImportWire = {
  format: 'character-card-v2',
  agent: {
    name: 'minji-kim-imported',
    description: 'Minji Kim is a patient Korean tutor.',
    systemPrompt: 'Stay in character as Minji Kim.',
    toolRefs: [],
    memoryScope: 'session',
    profile: {
      displayName: 'Minji Kim',
      avatar: { kind: 'emoji', value: '🤖' },
      color: '#6366f1',
      greeting: '안녕하세요!',
      examples: [{ user: 'Hi', assistant: '안녕하세요' }],
      knowledge: [
        { id: 'lore-1', title: 'Honorifics', inject: 'on-demand' },
        { id: 'lore-2', title: 'Hometown', inject: 'always' },
      ],
      guardrails: { policy: 'Correct gently.' },
      mcpServers: [],
      skills: [],
    },
  },
  losses: [
    { field: 'data.tags', action: 'kept-in-extensions', into: "profile.extensions['character-card-v2']", note: 'kept-unmapped-field' },
    { field: 'data.description', action: 'merged', into: 'systemPrompt', note: 'merged-into-instructions' },
    { field: 'data.character_book.entries[2]', action: 'dropped', note: 'lore-disabled', value: 'Disabled entry' },
    { field: 'avatar', action: 'defaulted', into: 'profile.avatar', note: 'defaulted-avatar', value: '🤖' },
  ],
  warnings: ['renamed'],
  report: { renamedFrom: 'minji-kim', sourceHash: '0123456789abcdef'.repeat(4), secretsRedacted: 2 },
  applied: false,
};

const preview = (over: Partial<ImportWire> = {}) =>
  render(
    <ParticipantImportPreview
      fileName="minji.v2.json"
      preview={{ ...PLAN, ...over }}
      decisions={{ name: PLAN.agent.name, displayName: 'Minji Kim', description: PLAN.agent.description! }}
      busy={false}
      onDecisions={noop}
      onConfirm={noop}
      onCancel={noop}
      onAnother={noop}
    />,
  );

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('ParticipantImportPreview — the loss report', () => {
  it('lists every loss with its action icon, field, value and translated note', () => {
    const html = preview();
    expect(html).toContain('Not carried over as-is (4)');
    for (const action of ['kept-in-extensions', 'merged', 'dropped', 'defaulted']) {
      expect(html).toContain(`data-loss-action="${action}"`);
    }
    for (const icon of ['📦', '🔀', '✂️', '↺']) expect(html).toContain(icon);
    expect(html).toContain('data.character_book.entries[2]');
    expect(html).toContain('(Disabled entry)');
    expect(html).toContain('Lorebook entry is switched off');
    expect(html).toContain('naby has no use for this field; the original is kept with the participant');
    expect(html).toContain('→ systemPrompt');
    expect(html).toContain('>Dropped</span>');
  });

  it('says so when nothing was lost', () => {
    const html = preview({ losses: [] });
    expect(html).toContain('Everything in the file came in.');
    expect(html).not.toContain('data-loss-action');
  });

  it('an unknown note key still renders (the key itself), never blank', () => {
    const html = preview({ losses: [{ field: 'x', action: 'dropped', note: 'brand-new-note' }] });
    expect(html).toContain('brand-new-note');
  });
});

describe('ParticipantImportPreview — safety badges, decisions and mapping', () => {
  it('shows kind, secrets masked, the rename, tools and the short source hash', () => {
    const html = preview();
    expect(html).toContain('Added as a participant');
    expect(html).toContain('2 secret(s) masked');
    expect(html).toContain('Renamed from @minji-kim');
    expect(html).toContain('No tools');
    expect(html).toContain('sha256 01234567');
    expect(html).toContain('That handle is taken here, so it comes in under a new one.');
  });

  it('flags instructions that look like a credential, and the v1 hint toward agent.import', () => {
    const html = preview({ warnings: ['prompt-looks-secret', 'sidecar-v1-use-agent-import'], report: { ...PLAN.report, secretsRedacted: 0 } });
    expect(html).toContain('data-badge="prompt-secret"');
    expect(html).toContain('No secrets found');
    expect(html).toContain('import it as an agent instead');
  });

  it('the decisions are editable fields pre-filled from the plan', () => {
    const html = preview();
    expect(html).toContain('data-testid="import-display-name" value="Minji Kim"');
    expect(html).toContain('value="minji-kim-imported"');
    expect(html).toContain('Minji Kim is a patient Korean tutor.</textarea>');
    expect(html).toContain('naby reads this sentence to decide when to hand work over');
  });

  it('the mapping table summarises what comes in', () => {
    const html = preview();
    expect(html).toContain('data-testid="import-mapping"');
    expect(html).toContain('2 (1 always, 1 on demand)');
    expect(html).toContain('Correct gently.');
    expect(html).toContain('Session model');
    expect(html).toContain('This conversation only');
    expect(html).toContain('Character card V2');
  });

  it('renders in Korean', async () => {
    await i18n.changeLanguage('ko');
    try {
      const html = preview();
      expect(html).toContain('그대로 들어오지 않는 것 (4)');
      expect(html).toContain('꺼진 로어북 항목입니다');
      expect(html).toContain('참가자로 추가합니다');
      expect(html).toContain('캐릭터 카드 V2');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('ParticipantImportPicker and the helpers', () => {
  it('the picker offers a drop zone and a file input for the supported formats', () => {
    const html = render(<ParticipantImportPicker onFile={noop} onCancel={noop} />);
    expect(html).toContain('data-testid="import-dropzone"');
    expect(html).toContain('accept=".md,.markdown,.json,.png,.charx"');
    expect(html).toContain('character card V2/V3');
  });

  it('problems map to sentences; the origin badge reads "format · day"', () => {
    const t = i18n.t.bind(i18n);
    expect(importProblemText(t, 'unrecognized format')).toBe('This file is not a format naby can import as a participant.');
    expect(importProblemText(t, 'newer-format: 3 (this naby reads up to 2)')).toBe('This file was written by a newer naby.');
    expect(importProblemText(t, 'something else')).toBe('something else');
    expect(importFormatLabel(t, 'claude-agent-md')).toBe('Claude Code subagent');
    const at = new Date(2026, 9, 16, 9, 30).getTime();
    expect(localDay(at)).toBe('2026-10-16');
    expect(originBadgeText(t, { format: 'character-card-v3', importedAt: at })).toBe('Character card V3 · 2026-10-16');
  });
});
