import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { ThemeProvider } from '@cockpit/shared-ui';
import { CrossProjectApprovalCard } from './CrossProjectApprovalCard';
import { MessageBubble } from './MessageBubble';
import { ProposalOutcomeLine } from './ToolApprovalPrompt';
import { EMPTY_PARTICIPANTS, ParticipantsProvider } from './ParticipantsContext';
import { crossProjectFromApproval, QUESTION_SLOTS, splitQuestion } from './crossProjectApproval';
import type { ChatMessage } from './types';

/**
 * cross-project-context R10, R17 — the access card and the project-aware
 * cross-session pill, rendered statically (no DOM harness in this repo), plus
 * the pure reader and source facts the static render cannot show.
 */

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <ThemeProvider>
      <I18nextProvider i18n={i18n}>
        <ParticipantsProvider value={EMPTY_PARTICIPANTS}>{node}</ParticipantsProvider>
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

describe('crossProjectFromApproval', () => {
  it('reads a cross_project request and ignores everything else', () => {
    const d = {
      approvalId: 'x',
      source: 'cross_project',
      tool_name: 'cross_project.access',
      input: { project: 'server', cwd: '/p/server', kind: 'read' },
    };
    expect(crossProjectFromApproval(d)).toEqual({ project: 'server', cwd: '/p/server', kind: 'read', relation: 'other-group' });
    expect(crossProjectFromApproval({ ...d, input: { ...d.input, kind: 'send', sessionTitle: 'API' } })).toEqual({
      project: 'server',
      cwd: '/p/server',
      kind: 'send',
      sessionTitle: 'API',
      relation: 'other-group',
    });
    expect(crossProjectFromApproval({ ...d, input: { ...d.input, relation: 'same-group', group: 'RMS' } })).toEqual({
      project: 'server',
      cwd: '/p/server',
      kind: 'read',
      relation: 'same-group',
      group: 'RMS',
    });
    // A same-group card without a group name falls back to the plain note.
    expect(crossProjectFromApproval({ ...d, input: { ...d.input, relation: 'same-group' } })?.relation).toBe('other-group');
    expect(crossProjectFromApproval({ ...d, source: 'participant_draft' })).toBeNull();
    expect(crossProjectFromApproval({ ...d, input: { project: 'server' } })).toBeNull();
  });

  it('splits the question around the name and the cwd', () => {
    const card = { project: 'server', cwd: '/p/server', kind: 'read' as const, relation: 'other-group' as const };
    const parts = splitQuestion(`read ${QUESTION_SLOTS.project} (${QUESTION_SLOTS.cwd}).`, card);
    expect(parts).toEqual([
      { kind: 'text', text: 'read ' },
      { kind: 'project', text: '‹server›' },
      { kind: 'text', text: ' (' },
      { kind: 'cwd', text: '/p/server' },
      { kind: 'text', text: ').' },
    ]);
  });
});

describe('CrossProjectApprovalCard (R17)', () => {
  it('read: the name bold, the cwd as code, the other-group note, three buttons', () => {
    const html = render(
      <CrossProjectApprovalCard card={{ project: 'server', cwd: '/p/server', kind: 'read', relation: 'other-group' }} busy={false} more={0} onAllowOnce={noop} onAllowAlways={noop} onDeny={noop} />,
    );
    expect(html).toContain('data-testid="cross-project-approval"');
    expect(html).toContain('<b>‹server›</b>');
    expect(html).toMatch(/<code[^>]*>\/p\/server<\/code>/);
    expect(html).toContain('read the contents of another project');
    expect(html).toContain('different group');
    expect(html).toContain('Allow once');
    expect(html).toContain('Always allow');
    expect(html).toContain('Decline');
    expect(html).toContain('data-testid="cross-project-allow-always"');
    expect(html).not.toContain('in this conversation');
  });

  it('same group: the note names the group (R17)', () => {
    const html = render(
      <CrossProjectApprovalCard
        card={{ project: 'server', cwd: '/p/server', kind: 'read', relation: 'same-group', group: 'RMS' }}
        busy={false}
        more={0}
        onAllowOnce={noop}
        onAllowAlways={noop}
        onDeny={noop}
      />,
    );
    expect(html).toContain('data-relation="same-group"');
    expect(html).toContain('same group, ‹RMS›');
    expect(html).not.toContain('different group');
  });

  it('send: names the tab', () => {
    const html = render(
      <CrossProjectApprovalCard
        card={{ project: 'server', cwd: '/p/server', kind: 'send', sessionTitle: 'API', relation: 'other-group' }}
        busy={false}
        more={1}
        onAllowOnce={noop}
        onAllowAlways={noop}
        onDeny={noop}
      />,
    );
    expect(html).toContain('send a request to the tab ‹API›');
    expect(html).toContain('+1 more waiting');
  });

  it('ko copy matches the spec', async () => {
    await i18n.changeLanguage('ko');
    try {
      const html = render(
        <CrossProjectApprovalCard card={{ project: 'server', cwd: '/p/server', kind: 'read', relation: 'other-group' }} busy={false} more={0} onAllowOnce={noop} onAllowAlways={noop} onDeny={noop} />,
      );
      expect(html).toMatch(
        /<span>나비가 다른 프로젝트 <\/span><b>‹server›<\/b><span>\(<\/span><code[^>]*>\/p\/server<\/code><span>\)의 내용을 읽으려 합니다\.<\/span>/,
      );
      expect(html).toContain('이 프로젝트는 지금 프로젝트와 다른 그룹에 있습니다.');
      expect(html).toContain('이번만 허용');
      expect(html).toContain('항상 허용');
      expect(html).toContain('거절');
      const same = render(
        <CrossProjectApprovalCard
          card={{ project: 'server', cwd: '/p/server', kind: 'read', relation: 'same-group', group: 'RMS' }}
          busy={false}
          more={0}
          onAllowOnce={noop}
          onAllowAlways={noop}
          onDeny={noop}
        />,
      );
      expect(same).toContain('같은 그룹 ‹RMS›의 프로젝트입니다.');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('R7d, R7e (ko): the new-conversation copy and the numbered project label', async () => {
    await i18n.changeLanguage('ko');
    try {
      const fresh = render(
        <CrossProjectApprovalCard
          card={{ project: 'server', cwd: '/p/server', kind: 'send', newSession: true, relation: 'same-group', group: 'RMS', number: 1, section: 'RMS' }}
          busy={false}
          more={0}
          onAllowOnce={noop}
          onAllowAlways={noop}
          onDeny={noop}
        />,
      );
      expect(fresh).toMatch(
        /<span>나비가 다른 프로젝트 <\/span><b>RMS 1번 ‹server›<\/b><span>\(<\/span><code[^>]*>\/p\/server<\/code><span>\)에 새 대화를 열어 요청을 보내려 합니다\.<\/span>/,
      );
      expect(fresh).toContain('data-new-session="true"');
      const tab = render(
        <CrossProjectApprovalCard
          card={{ project: 'DT_RMS', cwd: '/p/dt', kind: 'send', sessionTitle: 'API', relation: 'same-group', group: 'RMS', number: 3, section: 'RMS' }}
          busy={false}
          more={0}
          onAllowOnce={noop}
          onAllowAlways={noop}
          onDeny={noop}
        />,
      );
      expect(tab).toContain('<b>RMS 3번 ‹DT_RMS›</b>');
      expect(tab).toContain('의 탭 ‹API›에 요청을 보내려 합니다.');
      const loose = render(
        <CrossProjectApprovalCard card={{ project: 'loose', cwd: '/p/loose', kind: 'read', relation: 'other-group', number: 2 }} busy={false} more={0} onAllowOnce={noop} onAllowAlways={noop} onDeny={noop} />,
      );
      expect(loose).toContain('<b>2번 ‹loose›</b>');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('R7d, R7e (en) and the reader: newSession drops the tab title, a bad number is ignored', () => {
    const html = render(
      <CrossProjectApprovalCard
        card={{ project: 'server', cwd: '/p/server', kind: 'send', newSession: true, relation: 'other-group', number: 1, section: 'Web' }}
        busy={false}
        more={0}
        onAllowOnce={noop}
        onAllowAlways={noop}
        onDeny={noop}
      />,
    );
    expect(html).toContain('open a new conversation in another project, ');
    expect(html).toContain('<b>Web #1 ‹server›</b>');
    const card = crossProjectFromApproval({
      source: 'cross_project',
      input: { project: 'server', cwd: '/p/server', kind: 'send', sessionTitle: 'X', newSession: true, number: 0, section: 'Web' },
    })!;
    expect(card).toEqual({ project: 'server', cwd: '/p/server', kind: 'send', newSession: true, relation: 'other-group' });
  });

  it('the answered line tells allow once from always allow', () => {
    const once = render(
      <ProposalOutcomeLine
        outcome={{ approvalId: 'a', displayName: 'server', decision: 'allow', crossProject: true }}
        onDismiss={noop}
      />,
    );
    expect(once).toContain('Allowed once');
    const always = render(
      <ProposalOutcomeLine
        outcome={{ approvalId: 'a', displayName: 'server', decision: 'allow', crossProject: true, always: true }}
        onDismiss={noop}
      />,
    );
    expect(always).toContain('won’t ask about server again');
  });

  it('the prompt draws it and never sends "remember" for it (source)', () => {
    const src = readFileSync(join(__dirname, 'ToolApprovalPrompt.tsx'), 'utf8');
    expect(src).toContain('crossProjectFromApproval(d)');
    expect(src).toContain('remember && !current.proposal && !current.crossProject');
    expect(src).toMatch(/<CrossProjectApprovalCard[\s\S]{0,200}onAllowOnce=\{\(\) => void act\('allow', false\)\}/);
    expect(src).toMatch(/onAllowAlways=\{\(\) => void act\('allow', false, true\)\}/);
    // "always" travels as its own extra, only for this card.
    expect(src).toContain("...(always && decision === 'allow' && current.crossProject ? { always: true } : {})");
  });
});

describe('cross-session pill names the other project (R10)', () => {
  const pill = (ev: NonNullable<ChatMessage['systemEvent']>) =>
    render(<MessageBubble message={{ id: 'm', role: 'system', content: 'x', systemEvent: ev }} />);

  it('another project: project and session', () => {
    expect(pill({ kind: 'cross-session', status: 'request', peer: 'Plan', peerProject: 'proposal' })).toContain(
      'Request from session ‹Plan› of project ‹proposal›',
    );
    expect(pill({ kind: 'cross-session', status: 'reply', peer: 'API', peerProject: 'server' })).toContain(
      'Answer from session ‹API› of project ‹server›',
    );
  });

  it('the same project reads as before', () => {
    const html = pill({ kind: 'cross-session', status: 'request', peer: 'Plan' });
    expect(html).toContain('Request from session ‹Plan›');
    expect(html).not.toContain('of project');
  });

  it('ko: 프로젝트 ‹…›의 세션 ‹…›에서 온 요청 (R9)', async () => {
    await i18n.changeLanguage('ko');
    try {
      expect(pill({ kind: 'cross-session', status: 'request', peer: '제목', peerProject: 'proposal' })).toContain(
        '프로젝트 ‹proposal›의 세션 ‹제목›에서 온 요청',
      );
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('the live stream carries the project onto the pill (source)', () => {
    const src = readFileSync(join(__dirname, 'useLiveStream.ts'), 'utf8');
    expect(src).toContain('peerProject: cross.fromProject');
  });
});
