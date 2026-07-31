import { describe, it, expect } from 'vitest';
import type { McpEntry } from '../../../../../../../dist/naby-runtime.mjs';
import {
  ATLASSIAN_LAUNCHER,
  ATLASSIAN_PACKAGE,
  ATLASSIAN_SERVER_NAME,
  ATLASSIAN_URL_KEY,
  DEFAULT_CONFLUENCE_URL,
  DEFAULT_SKILL_HUB_URL,
  SKILL_HUB_SERVER_NAME,
  SKILL_HUB_URL_KEY,
  SYSTEM_MCP_PRESETS,
  SYSTEM_MCP_PRESET_NAMES,
  findSystemMcpPreset,
  mergeSystemMcpFields,
  normalizeBearerToken,
  readNonSecretFields,
  readPresetUrl,
  readSystemMcpStatus,
  type SystemMcpBuildOptions,
  type SystemMcpPreset,
} from './systemMcp';

/**
 * THE SYSTEM MCP PRESET REGISTRY (skill-hub-builtin §2.1, §3).
 *
 * The point of a preset is that the user supplies one or two strings and the
 * product supplies everything else, so what is worth asserting is what happens to
 * those strings on their way into an MCP entry — and that "is this connected" has
 * exactly one answer, computed here rather than re-derived by each surface.
 *
 * The registry is also asserted AS A REGISTRY: the invariants every preset must
 * hold are checked by iterating it, so a third preset added later is tested by
 * these same cases without anyone remembering to extend them.
 */

/** The mcp_servers table plus the settings table, as two maps. */
function fakeStore(entries: McpEntry[] = [], settings: Record<string, string> = {}) {
  const map = new Map(Object.entries(settings));
  return {
    listMcpEntries: (): McpEntry[] => entries,
    getSetting: (key: string): string | undefined => map.get(key),
  };
}

const skillHub = findSystemMcpPreset(SKILL_HUB_SERVER_NAME)!;
const atlassian = findSystemMcpPreset(ATLASSIAN_SERVER_NAME)!;

/** Build or throw — for the cases where the build is a precondition, not the
 *  thing under test. */
function built(
  preset: SystemMcpPreset,
  fields: Record<string, string>,
  opts?: SystemMcpBuildOptions,
): McpEntry {
  const res = preset.build(fields, opts);
  if (!res.ok) throw new Error(`build failed: ${res.error}`);
  return res.entry;
}

const UVX = '/opt/homebrew/bin/uvx';
const ATLASSIAN_FIELDS = { username: 'lee@altimedia.com', apiToken: 'atl_secret' };

describe('the registry itself', () => {
  it('holds both built-in presets, in display order', () => {
    expect(SYSTEM_MCP_PRESET_NAMES).toEqual([SKILL_HUB_SERVER_NAME, ATLASSIAN_SERVER_NAME]);
  });

  it('gives every preset a unique name and at least one field', () => {
    const names = new Set(SYSTEM_MCP_PRESETS.map((p) => p.name));
    expect(names.size).toBe(SYSTEM_MCP_PRESETS.length);
    for (const preset of SYSTEM_MCP_PRESETS) {
      expect(preset.fields.length, `${preset.name} asks for nothing`).toBeGreaterThan(0);
      // Two fields with one id would silently overwrite each other in the payload.
      const ids = new Set(preset.fields.map((f) => f.id));
      expect(ids.size).toBe(preset.fields.length);
    }
  });

  it('names an i18n key for everything it wants rendered', () => {
    // The UI translates; it never falls back to a raw identifier. A preset that
    // forgot a key would render "systemMcp.presets.x.title" to a user.
    for (const preset of SYSTEM_MCP_PRESETS) {
      expect(preset.titleKey).toMatch(/^systemMcp\./);
      expect(preset.descriptionKey).toMatch(/^systemMcp\./);
      for (const field of preset.fields) {
        expect(field.labelKey).toMatch(/^systemMcp\./);
        expect(field.placeholderKey).toMatch(/^systemMcp\./);
      }
    }
  });

  it('answers with nothing for a name it does not own', () => {
    expect(findSystemMcpPreset('filesystem')).toBeUndefined();
  });

  it('builds an entry whose name is the preset name', () => {
    // The general-list filter, the status reader and `mcp.approve` all key on it;
    // a build that named the entry anything else would strand its own row.
    expect(built(skillHub, { token: 'shub_abc' }).name).toBe(SKILL_HUB_SERVER_NAME);
    expect(built(atlassian, ATLASSIAN_FIELDS, { commandPath: UVX }).name).toBe(ATLASSIAN_SERVER_NAME);
  });

  it('enables what it builds, because typed credentials ARE the approval', () => {
    // 'proposed' exists for servers an AGENT added. A human who just typed a
    // credential should not then have to approve their own action.
    expect(built(skillHub, { token: 'shub_abc' }).status).toBe('enabled');
    expect(built(atlassian, ATLASSIAN_FIELDS, { commandPath: UVX }).status).toBe('enabled');
  });

  it('refuses every preset when a required field is blank, naming the field', () => {
    for (const preset of SYSTEM_MCP_PRESETS) {
      for (const field of preset.fields) {
        // Everything filled except this one.
        const fields: Record<string, string> = {};
        for (const other of preset.fields) {
          if (other.id !== field.id) fields[other.id] = other.id === 'username' ? 'a@b.com' : 'x';
        }
        const res = preset.build(fields, { commandPath: UVX });
        expect(res.ok, `${preset.name}/${field.id} was accepted blank`).toBe(false);
        if (res.ok) continue;
        expect(res.errorKey).toBe('systemMcp.fieldRequired');
        expect(res.errorField).toBe(field.id);
      }
    }
  });

  it('round-trips its own build through readStoredFields', () => {
    // This is what makes "blank keeps the stored secret" work: the reader must
    // recover exactly what the builder wrote, or an edit of one field would
    // rewrite the entry with a corrupted copy of the other.
    expect(skillHub.readStoredFields(built(skillHub, { token: 'shub_abc' }))).toEqual({
      token: 'shub_abc',
    });
    expect(
      atlassian.readStoredFields(built(atlassian, ATLASSIAN_FIELDS, { commandPath: UVX })),
    ).toEqual(ATLASSIAN_FIELDS);
  });

  it('is pure — two builds with the same inputs are indistinguishable', () => {
    expect(built(skillHub, { token: 'shub_x' })).toEqual(built(skillHub, { token: 'shub_x' }));
    expect(built(atlassian, ATLASSIAN_FIELDS, { commandPath: UVX })).toEqual(
      built(atlassian, ATLASSIAN_FIELDS, { commandPath: UVX }),
    );
  });
});

describe('normalizeBearerToken', () => {
  it('trims the whitespace a paste drags in', () => {
    expect(normalizeBearerToken('  shub_abc123\n')).toBe('shub_abc123');
  });

  it('strips a leading Bearer the user copied with the token', () => {
    // The failure this prevents: `Bearer Bearer shub_…`, which the hub rejects
    // with a 401 that reads like a bad token rather than a bad paste.
    expect(normalizeBearerToken('Bearer shub_abc123')).toBe('shub_abc123');
    expect(normalizeBearerToken('bearer   shub_abc123  ')).toBe('shub_abc123');
    expect(normalizeBearerToken('BEARER\tshub_abc123')).toBe('shub_abc123');
  });

  it('leaves a token that merely CONTAINS the word alone', () => {
    // Only a leading prefix is a prefix. Cutting mid-token would corrupt a
    // perfectly good credential and be near-impossible to diagnose.
    expect(normalizeBearerToken('shub_bearer_of_keys')).toBe('shub_bearer_of_keys');
  });

  it('reads an empty paste as empty rather than inventing something', () => {
    expect(normalizeBearerToken('   ')).toBe('');
    expect(normalizeBearerToken('Bearer   ')).toBe('');
  });
});

describe('the skill-hub preset', () => {
  it('assembles the whole entry from the token alone', () => {
    expect(built(skillHub, { token: 'shub_abc123' })).toEqual({
      name: SKILL_HUB_SERVER_NAME,
      transport: 'http',
      url: DEFAULT_SKILL_HUB_URL,
      headers: { Authorization: 'Bearer shub_abc123' },
      status: 'enabled',
    });
  });

  it('prefixes Bearer exactly once, however the token arrived', () => {
    const auth = (fields: Record<string, string>) => {
      const entry = built(skillHub, fields);
      return entry.transport === 'stdio' ? undefined : entry.headers?.Authorization;
    };
    expect(auth({ token: 'shub_abc123' })).toBe('Bearer shub_abc123');
    expect(auth({ token: 'Bearer shub_abc123' })).toBe('Bearer shub_abc123');
    expect(auth({ token: '  bearer shub_abc123 ' })).toBe('Bearer shub_abc123');
  });

  it('takes a URL override when one is passed', () => {
    const entry = built(skillHub, { token: 'shub_abc' }, { url: 'https://staging.internal/mcp' });
    expect(entry.transport === 'http' && entry.url).toBe('https://staging.internal/mcp');
  });

  it('falls back to the built-in URL for a blank override', () => {
    // The override reaches this from a settings row that may exist and be empty;
    // '' must mean "not overridden", not "no URL".
    const entry = built(skillHub, { token: 'shub_abc' }, { url: '   ' });
    expect(entry.transport === 'http' && entry.url).toBe(DEFAULT_SKILL_HUB_URL);
  });

  it('exposes nothing as a non-secret field — the token is all there is', () => {
    expect(readNonSecretFields(skillHub, built(skillHub, { token: 'shub_abc' }))).toEqual({});
  });

  it('ignores a launcher it does not have', () => {
    // http presets have no command to resolve; a build must not start demanding
    // one just because the registry supports launchers.
    expect(skillHub.launcher).toBeUndefined();
    expect(skillHub.build({ token: 'shub_abc' }).ok).toBe(true);
  });
});

describe('the atlassian preset', () => {
  it('assembles a stdio entry around the resolved uvx path', () => {
    expect(built(atlassian, ATLASSIAN_FIELDS, { commandPath: UVX })).toEqual({
      name: ATLASSIAN_SERVER_NAME,
      transport: 'stdio',
      command: UVX,
      args: [ATLASSIAN_PACKAGE],
      env: {
        CONFLUENCE_URL: DEFAULT_CONFLUENCE_URL,
        CONFLUENCE_USERNAME: 'lee@altimedia.com',
        CONFLUENCE_API_TOKEN: 'atl_secret',
      },
      status: 'enabled',
    });
  });

  it('declares uvx as its launcher, so the server knows to resolve one', () => {
    expect(atlassian.launcher).toBe(ATLASSIAN_LAUNCHER);
  });

  it('REFUSES to build when uvx could not be resolved', () => {
    // The refusal IS the feature (§2.1). An entry with a bare `uvx` command works
    // in dev and ENOENTs in the packaged app, where the child process inherits a
    // PATH with no user bin directories on it.
    for (const opts of [undefined, {}, { commandPath: '' }, { commandPath: '   ' }]) {
      const res = atlassian.build(ATLASSIAN_FIELDS, opts);
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.errorKey).toBe('systemMcp.uvxMissing');
      // The English fallback has to be actionable on its own, for a caller with
      // no dictionary: it names the tool to install.
      expect(res.error).toContain('uv');
    }
  });

  it('trims the email and keeps the token verbatim', () => {
    // The email is what a user pastes out of a profile page, so it arrives with
    // whitespace. A token is not trimmed INTO a different token — a leading space
    // in a real secret would be a real difference — but its own padding goes.
    const entry = built(
      atlassian,
      { username: '  lee@altimedia.com \n', apiToken: '  atl_secret  ' },
      { commandPath: UVX },
    );
    expect(entry.transport === 'stdio' && entry.env?.CONFLUENCE_USERNAME).toBe('lee@altimedia.com');
    expect(entry.transport === 'stdio' && entry.env?.CONFLUENCE_API_TOKEN).toBe('atl_secret');
  });

  it('rejects a username that is not an email address', () => {
    // Atlassian's Basic auth wants the account EMAIL; a bare username fails with
    // an opaque 401 that reads like a bad token.
    for (const username of ['lee', 'lee@altimedia', 'lee altimedia.com', '@altimedia.com']) {
      const res = atlassian.build({ ...ATLASSIAN_FIELDS, username }, { commandPath: UVX });
      expect(res.ok, `"${username}" was accepted`).toBe(false);
      if (res.ok) continue;
      expect(res.errorKey).toBe('systemMcp.presets.atlassian.badEmail');
      expect(res.errorField).toBe('username');
    }
  });

  it('accepts the shapes a real company email takes', () => {
    for (const username of ['lee@altimedia.com', 'lee.yong-sub+naby@altimedia.co.kr']) {
      expect(atlassian.build({ ...ATLASSIAN_FIELDS, username }, { commandPath: UVX }).ok).toBe(true);
    }
  });

  it('takes the Confluence URL override, and defaults without one', () => {
    const overridden = built(atlassian, ATLASSIAN_FIELDS, {
      commandPath: UVX,
      url: 'https://other.atlassian.net/wiki',
    });
    expect(overridden.transport === 'stdio' && overridden.env?.CONFLUENCE_URL).toBe(
      'https://other.atlassian.net/wiki',
    );
    const blank = built(atlassian, ATLASSIAN_FIELDS, { commandPath: UVX, url: '  ' });
    expect(blank.transport === 'stdio' && blank.env?.CONFLUENCE_URL).toBe(DEFAULT_CONFLUENCE_URL);
  });

  it('shows the email back and never the token', () => {
    const entry = built(atlassian, ATLASSIAN_FIELDS, { commandPath: UVX });
    expect(readNonSecretFields(atlassian, entry)).toEqual({ username: 'lee@altimedia.com' });
  });
});

describe('readPresetUrl', () => {
  it('answers the built-in URL when nothing is overridden', () => {
    expect(readPresetUrl(fakeStore(), skillHub)).toBe(DEFAULT_SKILL_HUB_URL);
    expect(readPresetUrl(fakeStore(), atlassian)).toBe(DEFAULT_CONFLUENCE_URL);
  });

  it('answers each preset own override key', () => {
    const store = fakeStore([], {
      [SKILL_HUB_URL_KEY]: 'https://staging.internal/mcp',
      [ATLASSIAN_URL_KEY]: 'https://other.atlassian.net/wiki',
    });
    expect(readPresetUrl(store, skillHub)).toBe('https://staging.internal/mcp');
    expect(readPresetUrl(store, atlassian)).toBe('https://other.atlassian.net/wiki');
  });

  it('treats a blank override as absent', () => {
    expect(readPresetUrl(fakeStore([], { [SKILL_HUB_URL_KEY]: '  ' }), skillHub)).toBe(
      DEFAULT_SKILL_HUB_URL,
    );
  });
});

describe('readSystemMcpStatus', () => {
  it('answers for EVERY preset, configured or not', () => {
    // A map missing a key would render as a blank row rather than as "not
    // connected", so absence is stated explicitly.
    expect(readSystemMcpStatus(fakeStore())).toEqual({
      [SKILL_HUB_SERVER_NAME]: { configured: false },
      [ATLASSIAN_SERVER_NAME]: { configured: false },
    });
  });

  it('reads enabled once an entry exists, per preset independently', () => {
    const store = fakeStore([built(skillHub, { token: 'shub_abc' })]);
    const status = readSystemMcpStatus(store);
    expect(status[SKILL_HUB_SERVER_NAME]).toEqual({ configured: true, status: 'enabled' });
    expect(status[ATLASSIAN_SERVER_NAME]).toEqual({ configured: false });
  });

  it('carries the non-secret fields, and only those', () => {
    const store = fakeStore([built(atlassian, ATLASSIAN_FIELDS, { commandPath: UVX })]);
    const status = readSystemMcpStatus(store)[ATLASSIAN_SERVER_NAME];
    expect(status).toEqual({
      configured: true,
      status: 'enabled',
      nonSecretFields: { username: 'lee@altimedia.com' },
    });
    // The serialized status is the thing that crosses the wire.
    expect(JSON.stringify(status)).not.toContain('atl_secret');
  });

  it('omits nonSecretFields entirely when there is nothing to show', () => {
    const store = fakeStore([built(skillHub, { token: 'shub_abc' })]);
    expect(readSystemMcpStatus(store)[SKILL_HUB_SERVER_NAME]).not.toHaveProperty('nonSecretFields');
  });

  it('reports an agent-proposed entry as proposed, not as connected', () => {
    // `naby_add_mcp` can propose a server under either preset name. It is
    // configured — the row exists — but it is NOT running until a human approves
    // it, and saying "connected" there would be the one lie that matters.
    const store = fakeStore([
      { name: SKILL_HUB_SERVER_NAME, transport: 'http', url: DEFAULT_SKILL_HUB_URL, status: 'proposed' },
      { name: ATLASSIAN_SERVER_NAME, transport: 'stdio', command: UVX, status: 'proposed' },
    ]);
    const status = readSystemMcpStatus(store);
    expect(status[SKILL_HUB_SERVER_NAME]?.status).toBe('proposed');
    expect(status[ATLASSIAN_SERVER_NAME]?.status).toBe('proposed');
  });

  it('treats a status-less legacy entry as enabled', () => {
    // The store leaves `status` off an ordinary entry; only a proposal carries it.
    const store = fakeStore([
      { name: SKILL_HUB_SERVER_NAME, transport: 'http', url: DEFAULT_SKILL_HUB_URL },
    ]);
    expect(readSystemMcpStatus(store)[SKILL_HUB_SERVER_NAME]).toEqual({
      configured: true,
      status: 'enabled',
    });
  });

  it('ignores every other server in the registry', () => {
    const store = fakeStore([
      { name: 'filesystem', transport: 'stdio', command: 'npx' },
      { name: 'weather', transport: 'http', url: 'https://example.com/mcp' },
    ]);
    expect(readSystemMcpStatus(store)).toEqual({
      [SKILL_HUB_SERVER_NAME]: { configured: false },
      [ATLASSIAN_SERVER_NAME]: { configured: false },
    });
  });
});

describe('mergeSystemMcpFields', () => {
  it('keeps a stored secret the user did not retype', () => {
    // THE FAILURE THIS PREVENTS: editing the Atlassian email with the token box
    // left blank (as it always is — the value cannot be shown) would otherwise
    // rebuild the entry with an empty token and silently break the connection.
    const stored = built(atlassian, ATLASSIAN_FIELDS, { commandPath: UVX });
    const merged = mergeSystemMcpFields(atlassian, stored, {
      username: 'new@altimedia.com',
      apiToken: '',
    });
    expect(merged).toEqual({ username: 'new@altimedia.com', apiToken: 'atl_secret' });
  });

  it('replaces a secret the user DID retype', () => {
    const stored = built(atlassian, ATLASSIAN_FIELDS, { commandPath: UVX });
    const merged = mergeSystemMcpFields(atlassian, stored, { apiToken: 'atl_rotated' });
    expect(merged.apiToken).toBe('atl_rotated');
    expect(merged.username).toBe('lee@altimedia.com');
  });

  it('treats whitespace as blank rather than as a new value', () => {
    const stored = built(skillHub, { token: 'shub_abc' });
    expect(mergeSystemMcpFields(skillHub, stored, { token: '   ' })).toEqual({ token: 'shub_abc' });
  });

  it('starts from nothing when the preset was never configured', () => {
    expect(mergeSystemMcpFields(skillHub, undefined, { token: 'shub_new' })).toEqual({
      token: 'shub_new',
    });
    expect(mergeSystemMcpFields(skillHub, undefined, {})).toEqual({});
  });

  it('ignores keys the preset does not declare', () => {
    // The payload comes from a client; a field the preset never asked for must
    // not reach `build` and must not survive into a stored entry.
    const merged = mergeSystemMcpFields(skillHub, undefined, {
      token: 'shub_new',
      somethingElse: 'x',
    });
    expect(merged).toEqual({ token: 'shub_new' });
  });
});
