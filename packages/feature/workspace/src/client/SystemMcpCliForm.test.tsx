import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { SystemMcpCliControls, systemMcpCliPhase } from './SystemMcpCliForm';
import { SYSTEM_MCP_PRESETS, type SystemMcpStatus } from './systemMcpPresets';

/**
 * THE ASIDE CARD — three states, one forward button each (skill-hub-builtin
 * §2.8). Rendered with `renderToStaticMarkup`; what the buttons post is pinned
 * server-side in feature-agent `server/api/naby.test.ts`.
 */

const aside = SYSTEM_MCP_PRESETS.find((p) => p.name === 'aside')!;
const noop = () => {};

const render = (state: SystemMcpStatus, cliFound: boolean | undefined) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <SystemMcpCliControls
        preset={aside}
        state={state}
        cliFound={cliFound}
        busy={false}
        note={null}
        onConnect={noop}
        onDisconnect={noop}
        onCheck={noop}
      />
    </I18nextProvider>,
  );

/** `[text, disabled]` per <button>. */
const buttons = (html: string) =>
  [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((m) => [m[2], /\sdisabled=""/.test(m[1])]);

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('the aside card', () => {
  it('is a CLI preset in the client mirror', () => {
    expect(aside.cli).toBe(true);
    expect(aside.fields).toEqual([]);
  });

  it('CLI missing → install guidance, Connect disabled, Check again', () => {
    const html = render({ configured: false }, false);
    expect(html).toContain('data-phase="missing"');
    expect(html).toContain('Settings › Developers');
    expect(html).toContain('PowerShell');
    expect(buttons(html)).toEqual([
      ['Connect', true],
      ['Check again', false],
    ]);
  });

  it('ready → Connect', () => {
    const html = render({ configured: false }, true);
    expect(html).toContain('data-phase="ready"');
    expect(buttons(html)).toEqual([['Connect', false]]);
  });

  it('connected → Disconnect, whatever the CLI probe says', () => {
    for (const cli of [true, false, undefined]) {
      const html = render({ configured: true, status: 'enabled' }, cli);
      expect(html).toContain('data-phase="connected"');
      expect(buttons(html)).toEqual([['Disconnect', false]]);
    }
  });

  it('not yet checked → Connect stays disabled', () => {
    expect(buttons(render({ configured: false }, undefined))).toEqual([['Connect', true]]);
  });

  it('always carries the one-line remote-login note', () => {
    for (const html of [render({ configured: false }, false), render({ configured: true }, true)]) {
      expect(html).toContain('aside login --email');
    }
  });

  it('phases follow the status', () => {
    expect(systemMcpCliPhase({ configured: false }, false)).toBe('missing');
    expect(systemMcpCliPhase({ configured: false }, true)).toBe('ready');
    expect(systemMcpCliPhase({ configured: true }, false)).toBe('connected');
  });

  it('renders in Korean too', async () => {
    await i18n.changeLanguage('ko');
    const html = render({ configured: false }, false);
    expect(html).toContain('Aside 앱 설정 › Developers에서 설치합니다');
    expect(buttons(html).map((b) => b[0])).toEqual(['연결', '다시 확인']);
    expect(buttons(render({ configured: true }, true)).map((b) => b[0])).toEqual(['연결 끊기']);
    await i18n.changeLanguage('en');
  });
});
