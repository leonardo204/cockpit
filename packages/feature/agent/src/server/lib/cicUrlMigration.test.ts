import { describe, expect, it } from 'vitest';
import { CIC_MCP_URL, migrateCicUrl, migratedCicUrl } from '../../../../../../../dist/naby-runtime.mjs';
import { DEFAULT_CIC_URL } from './systemMcp';

// CIC moved off the VM (2026-10-28); the old path now answers 404.
const OLD = ['https://skills', 'altimedia.com/cic/mcp'].join('.');

type Entry = { name: string; transport: string; url?: string; headers?: Record<string, string>; command?: string };

function fakeStore(entries: Entry[], settings: Record<string, string> = {}) {
  const rows = new Map(entries.map((e) => [e.name, { ...e }]));
  return {
    rows,
    settings,
    listMcpEntries: () => [...rows.values()],
    upsertMcpEntry: (e: Entry) => void rows.set(e.name, e),
    getSetting: (k: string) => settings[k],
    setSetting: (k: string, v: string) => void (settings[k] = v),
  };
}

describe('cic URL migration', () => {
  it('the preset ships the new https root address', () => {
    expect(DEFAULT_CIC_URL).toBe('https://cic.altimedia.com/mcp');
    expect(CIC_MCP_URL).toBe(DEFAULT_CIC_URL);
  });

  it('maps the retired path (http or https) to the new root, dropping /cic', () => {
    expect(migratedCicUrl(OLD)).toBe('https://cic.altimedia.com/mcp');
    expect(migratedCicUrl(OLD.replace('https:', 'http:'))).toBe('https://cic.altimedia.com/mcp');
    expect(migratedCicUrl(OLD.replace('/mcp', ''))).toBe('https://cic.altimedia.com/mcp');
    expect(migratedCicUrl(OLD.replace('/cic/mcp', '/cic-old/mcp'))).toBeUndefined();
    expect(migratedCicUrl('https://skill-hub.example/mcp')).toBeUndefined();
  });

  it('rewrites the stored cic row, keeping its token header, and clears an old override', () => {
    const store = fakeStore(
      [
        { name: 'cic', transport: 'http', url: OLD, headers: { Authorization: 'Bearer t' } },
        { name: 'other', transport: 'http', url: 'https://example.com/mcp' },
        { name: 'local', transport: 'stdio', command: 'x' },
      ],
      { 'cic.url': OLD },
    );
    expect(migrateCicUrl(store)).toEqual({ entries: ['cic'], setting: true });
    expect(store.rows.get('cic')).toEqual({
      name: 'cic',
      transport: 'http',
      url: 'https://cic.altimedia.com/mcp',
      headers: { Authorization: 'Bearer t' },
    });
    expect(store.rows.get('other')?.url).toBe('https://example.com/mcp');
    expect(store.settings['cic.url']).toBe('');
    // Second boot: nothing left to do.
    expect(migrateCicUrl(store)).toEqual({ entries: [], setting: false });
  });

  it('leaves a user-chosen override alone', () => {
    const store = fakeStore([], { 'cic.url': 'https://staging.example/mcp' });
    expect(migrateCicUrl(store).setting).toBe(false);
    expect(store.settings['cic.url']).toBe('https://staging.example/mcp');
  });
});
