import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_OAUTH_CATALOG, MCP_OAUTH_CATALOG_NAMES } from './mcpOAuthCatalog';
import {
  MCP_OAUTH_CATALOG as SERVER_CATALOG,
  findMcpOAuthCatalogEntry,
} from '@cockpit/feature-agent/server/lib/mcpOAuthCatalog';
import { SYSTEM_MCP_PRESET_NAMES } from './systemMcpPresets';

/**
 * THE CLIENT QUICK-CONNECT MIRROR MATCHES THE SERVER LIST (mcp-oauth-catalog §4.2).
 *
 * The renderer cannot import the server module (it imports the runtime bundle,
 * and with it `node:sqlite`), so the presentational half is mirrored in
 * `mcpOAuthCatalog.ts`, the way the System MCP presets are. A mirror that drifts
 * would draw a row whose name no action recognises, or miss one the server
 * reports — so the two are compared here, in a node test that can import both.
 */

describe('the client quick-connect mirror', () => {
  it('lists the same servers, in the same order', () => {
    expect(MCP_OAUTH_CATALOG_NAMES).toEqual(SERVER_CATALOG.map((c) => c.name));
  });

  it('mirrors every name and i18n key, and nothing else', () => {
    expect(MCP_OAUTH_CATALOG).toEqual(
      SERVER_CATALOG.map((c) => ({ name: c.name, titleKey: c.titleKey, descriptionKey: c.descriptionKey })),
    );
  });

  it('starts with the four servers the user chose (§1), at their checked URLs (§2)', () => {
    expect(SERVER_CATALOG.map((c) => [c.name, c.url])).toEqual([
      ['notion', 'https://mcp.notion.com/mcp'],
      ['linear', 'https://mcp.linear.app/mcp'],
      ['asana', 'https://mcp.asana.com/v2/mcp'],
      ['sentry', 'https://mcp.sentry.dev/mcp'],
    ]);
    // Asana's older SSE address is not the one used.
    expect(findMcpOAuthCatalogEntry('asana')?.url.endsWith('/sse')).toBe(false);
  });

  it('never takes a System MCP preset name', () => {
    for (const name of MCP_OAUTH_CATALOG_NAMES) expect(SYSTEM_MCP_PRESET_NAMES).not.toContain(name);
  });

  it('carries no URL — the server resolves a catalog name to its address', () => {
    const source = readFileSync(join(__dirname, 'mcpOAuthCatalog.ts'), 'utf8');
    for (const host of ['mcp.notion.com', 'mcp.linear.app', 'mcp.asana.com', 'mcp.sentry.dev', 'https://']) {
      expect(source, `${host} leaked into the client mirror`).not.toContain(host);
    }
  });
});

describe('the i18n dictionaries answer every quick-connect key', () => {
  const dict = (locale: string) =>
    JSON.parse(
      readFileSync(join(__dirname, '../../../../shared/i18n/locales', `${locale}.json`), 'utf8'),
    ) as Record<string, unknown>;

  const lookup = (source: Record<string, unknown>, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => {
      if (!node || typeof node !== 'object') return undefined;
      return (node as Record<string, unknown>)[part];
    }, source);

  for (const locale of ['en', 'ko']) {
    it(`${locale} translates every entry's title and description`, () => {
      const source = dict(locale);
      for (const entry of MCP_OAUTH_CATALOG) {
        expect(lookup(source, entry.titleKey), `${locale}: ${entry.titleKey}`).toBeTypeOf('string');
        expect(lookup(source, entry.descriptionKey), `${locale}: ${entry.descriptionKey}`).toBeTypeOf('string');
      }
    });

    it(`${locale} carries the shared browser sign-in copy`, () => {
      const source = dict(locale);
      for (const key of [
        'mcpOAuth.quickConnect.title',
        'mcpOAuth.quickConnect.description',
        'mcpOAuth.connect',
        'mcpOAuth.disconnect',
        'mcpOAuth.login',
        'mcpOAuth.relogin',
        'mcpOAuth.reloginHint',
        'mcpOAuth.loginDone',
        'mcpOAuth.loginFailed',
        'mcpOAuth.nameTaken',
        'mcpOAuth.presetName',
        'mcpOAuth.oauthRowLocked',
        'mcpOAuth.status.connected',
        'mcpOAuth.status.relogin',
        'mcpOAuth.status.none',
        'mcpOAuth.probe.checking',
        'mcpOAuth.probe.oauth',
        'mcpOAuth.probe.noRegistration',
        'mcpOAuth.probe.unreachable',
        'mcpOAuth.probe.saveAnyway',
        'mcpOAuth.probe.approveAnyway',
      ]) {
        expect(lookup(source, key), `${locale}: ${key}`).toBeTypeOf('string');
      }
      expect(lookup(source, 'mcpOAuth.loginFailed')).toContain('{{error}}');
      expect(lookup(source, 'mcpOAuth.probe.unreachable')).toContain('{{error}}');
    });
  }

  it('ko says what the spec says, in settings register (~합니다체)', () => {
    const ko = dict('ko');
    expect(lookup(ko, 'mcpOAuth.quickConnect.title')).toBe('바로 연결');
    expect(lookup(ko, 'mcpOAuth.nameTaken')).toBe('같은 이름의 서버가 이미 있습니다.');
    expect(lookup(ko, 'mcpOAuth.probe.oauth')).toBe('이 서버는 브라우저 로그인으로 연결합니다.');
    expect(lookup(ko, 'mcpOAuth.probe.noRegistration')).toBe(
      '이 서버는 자동 로그인을 지원하지 않습니다. 헤더에 토큰을 넣어 주세요.',
    );
    expect(lookup(ko, 'mcpOAuth.probe.saveAnyway')).toBe('그래도 저장');
  });
});
