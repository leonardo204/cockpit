import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import type { McpOAuthCatalogView } from '@cockpit/feature-agent';
import { McpOAuthStatusBadge, McpQuickConnectSection } from './NabyMcpOAuth';
import { OAuthLoginButton } from './OAuthLoginButton';

/**
 * QUICK CONNECT IN SETTINGS → CONNECTIONS (mcp-oauth-catalog §3.1).
 *
 * Rendered with `renderToStaticMarkup` (there is no DOM harness in this repo):
 * these pin which ONE button each state shows. What the buttons do — the row
 * appearing only after a sign-in, disconnect taking the tokens, the per-server
 * pending sign-ins — is pinned server-side in
 * feature-agent `server/lib/mcpOAuthServers.test.ts`.
 */

const view = (v: Partial<McpOAuthCatalogView> = {}): McpOAuthCatalogView => ({
  status: 'none',
  pending: false,
  conflict: false,
  present: false,
  ...v,
});

const render = (catalog: Record<string, McpOAuthCatalogView>) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <McpQuickConnectSection catalog={catalog} onChanged={() => {}} />
    </I18nextProvider>,
  );

/** The markup of one quick-connect row. */
function rowOf(html: string, name: string): string {
  const marker = `data-testid="mcp-quick-connect-${name}"`;
  const start = html.indexOf(marker);
  if (start < 0) return '';
  const next = html.indexOf('data-testid="mcp-quick-connect-', start + marker.length);
  return html.slice(start, next < 0 ? undefined : next);
}

/** The visible texts of the <button>s in a chunk of markup. */
const buttons = (chunk: string) =>
  [...chunk.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

const FOUR = {
  notion: view(),
  linear: view({ pending: true }),
  asana: view({ status: 'connected', present: true }),
  sentry: view({ status: 'relogin', present: true }),
};

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('quick connect — four states, one button each (§3.1)', () => {
  it('not connected → Connect; signing in → Cancel; connected → Disconnect; sign in again → Log in again', () => {
    const html = render(FOUR);
    expect(html).toContain('Quick connect');
    expect(buttons(rowOf(html, 'notion'))).toEqual(['Connect']);
    expect(buttons(rowOf(html, 'linear'))).toEqual(['Cancel']);
    expect(rowOf(html, 'linear')).toContain('Waiting for the browser…');
    expect(buttons(rowOf(html, 'asana'))).toEqual(['Disconnect']);
    expect(buttons(rowOf(html, 'sentry'))).toEqual(['Log in again']);
  });

  it('names every server with its own title and description', () => {
    const html = render(FOUR);
    for (const [name, title] of [
      ['notion', 'Notion'],
      ['linear', 'Linear'],
      ['asana', 'Asana'],
      ['sentry', 'Sentry'],
    ] as const) {
      expect(rowOf(html, name)).toContain(title);
    }
    expect(rowOf(html, 'notion')).toContain('pages and databases');
  });

  it('a taken name shows the clash and no button at all', () => {
    const html = render({ ...FOUR, notion: view({ conflict: true }) });
    expect(rowOf(html, 'notion')).toContain('A server with the same name already exists.');
    expect(buttons(rowOf(html, 'notion'))).toEqual([]);
  });

  it('a failed sign-in is said under the row', () => {
    const html = render({ ...FOUR, notion: view({ lastError: 'access_denied' }) });
    expect(rowOf(html, 'notion')).toContain('Notion sign-in failed: access_denied');
    expect(buttons(rowOf(html, 'notion'))).toEqual(['Connect']);
  });

  it('renders the Korean copy', async () => {
    await i18n.changeLanguage('ko');
    try {
      const html = render(FOUR);
      expect(html).toContain('바로 연결');
      expect(buttons(rowOf(html, 'notion'))).toEqual(['연결']);
      expect(buttons(rowOf(html, 'linear'))).toEqual(['취소']);
      expect(buttons(rowOf(html, 'asana'))).toEqual(['연결 끊기']);
      expect(buttons(rowOf(html, 'sentry'))).toEqual(['다시 로그인']);
      const clash = render({ ...FOUR, notion: view({ conflict: true }) });
      expect(rowOf(clash, 'notion')).toContain('같은 이름의 서버가 이미 있습니다.');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('the generic sign-in button and the OAuth badge', () => {
  const noop = async () => {};
  const button = (pending: boolean, variant?: 'default' | 'single') =>
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <OAuthLoginButton
          testId="x"
          pending={pending}
          label="Log in"
          start={async () => ({ ok: true })}
          cancel={noop}
          read={async () => null}
          doneMessage="done"
          failedMessage={(e) => e}
          {...(variant ? { variant } : {})}
        />
      </I18nextProvider>,
    );

  it('idle: one enabled button with the caller\'s label', () => {
    const html = button(false);
    expect(buttons(html)).toEqual(['Log in']);
    expect(html).not.toMatch(/\sdisabled=""/);
  });

  it('pending (default, the Atlassian look): a disabled waiting button and Cancel', () => {
    const html = button(true);
    expect(buttons(html)).toEqual(['Waiting for the browser…', 'Cancel']);
    expect(html).toMatch(/\sdisabled=""/);
  });

  it('the badge says connected / log in again / not signed in', () => {
    const r = (s: 'connected' | 'relogin' | 'none') =>
      renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <McpOAuthStatusBadge status={s} />
        </I18nextProvider>,
      );
    expect(r('connected')).toContain('connected');
    expect(r('relogin')).toContain('log in again');
    expect(r('none')).toContain('not signed in');
  });
});

describe('the Connections list is wired as the spec says (source checks)', () => {
  const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');
  const setup = read('NabyProviderSetup.tsx');

  it('quick connect sits above the general list, and its rows are not listed twice', () => {
    expect(setup).toContain('<McpQuickConnectSection catalog={oauth?.catalog}');
    expect(setup.indexOf('<McpQuickConnectSection')).toBeLessThan(setup.indexOf("t('providerSetup.mcpServers')"));
    expect(setup).toContain('!catalog[r.name]?.present');
  });

  it('the add form checks the URL on save, only for a remote server without headers', () => {
    expect(setup).toMatch(/transport !== 'stdio' && !headers && !opts\.skipCheck/);
    expect(setup).toContain('probeMcpOAuthUrl(url.trim(), transport)');
    expect(setup).toContain("t('mcpOAuth.probe.saveAnyway')");
    expect(setup).toContain("t('mcpOAuth.probe.noRegistration')");
  });

  it('an OAuth row has a badge and a log-in button, and no edit and no header line', () => {
    expect(setup).toContain('{isOAuth && <McpOAuthStatusBadge status={oauthStatus} />}');
    expect(setup).toContain('{!isOAuth && (\n                  <button');
    expect(setup).toContain('!isOAuth && (row.envKeys?.length || row.headerKeys?.length)');
  });

  it('approving a remote proposal runs the same URL check and can turn into a sign-in', () => {
    expect(setup).toContain('probeMcpOAuthUrl(row.url, row.transport)');
    expect(setup).toContain("check?.probe?.verdict === 'oauth'");
  });

  it('the Atlassian button is the generic button with the Atlassian requests', () => {
    const atl = read('AtlassianLoginButton.tsx');
    expect(atl).toContain('<OAuthLoginButton');
    expect(atl).toContain('testId="atlassian-login"');
  });
});
