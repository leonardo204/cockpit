import { describe, it, expect, afterAll } from 'vitest';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { CrossProjectApprovalList, CrossProjectToggle } from './CrossProjectToggle';

/**
 * cross-project-context R6, R18a — the "look into other projects" switch and
 * the permanent-approval list under it, rendered statically, and where it sits
 * (next to the cross-session switch).
 */

const render = (node: ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('CrossProjectToggle', () => {
  it('renders checked by default, with its label and hint (ko)', async () => {
    await i18n.changeLanguage('ko');
    const html = render(<CrossProjectToggle isOpen={false} />);
    expect(html).toContain('data-testid="cross-project-toggle"');
    expect(html).toContain('checked=""');
    expect(html).toContain('다른 프로젝트 보기');
    // 0.2.0: the hint no longer says the same group is read without asking.
    expect(html).toContain('그룹 안이든 밖이든 먼저 묻습니다.');
    expect(html).not.toContain('바로 읽고');
    // R18a: the list sits under it, empty at first.
    expect(html).toContain('아직 항상 허용한 프로젝트가 없습니다.');
  });

  it('lists permanent pairs by display name, cwd on hover, a project gone from the sidebar dimmed', async () => {
    await i18n.changeLanguage('en');
    const html = render(
      <CrossProjectApprovalList
        approvals={[
          { from: '/p/proposal', to: '/p/server', fromName: 'proposal', toName: 'server', fromListed: true, toListed: true },
          { from: '/p/proposal', to: '/gone/x', fromName: 'proposal', toName: 'x', fromListed: true, toListed: false },
        ]}
        removing={null}
        onRemove={() => {}}
      />,
    );
    const rows = html.split('data-testid="cross-project-approval-row"');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('data-missing="false"');
    expect(rows[1]).toContain('title="/p/proposal"');
    expect(rows[1]).toContain('<span title="/p/proposal">‹proposal›</span> → <span title="/p/server">‹server›</span>');
    expect(rows[1]).toContain('title="/p/server"');
    expect(rows[1]).toContain('data-testid="cross-project-approval-remove"');
    expect(rows[2]).toContain('data-missing="true"');
    expect(rows[2]).toContain('opacity-50');
    expect(rows[2]).toContain('Not in the sidebar any more');
    expect(rows[2]).toContain('data-testid="cross-project-approval-remove"');
    expect(html).not.toContain('No project is always allowed yet.');
  });

  it('removes through its own action (source)', () => {
    const src = readFileSync(join(__dirname, 'CrossProjectToggle.tsx'), 'utf8');
    expect(src).toContain("action: 'crossProject.removeApproval', from: row.from, to: row.to");
  });

  it('reads and writes its own setting actions (source)', () => {
    const src = readFileSync(join(__dirname, 'CrossProjectToggle.tsx'), 'utf8');
    expect(src).toContain("action: 'crossProject.get'");
    expect(src).toContain("action: 'crossProject.set'");
  });

  it('sits right after the cross-session switch in the agent manager (source)', () => {
    const src = readFileSync(join(__dirname, 'NabyAgentManager.tsx'), 'utf8');
    const session = src.indexOf('<CrossSessionToggle isOpen={isOpen} />');
    const project = src.indexOf('<CrossProjectToggle isOpen={isOpen} />');
    expect(session).toBeGreaterThan(0);
    expect(project).toBeGreaterThan(session);
  });
});
