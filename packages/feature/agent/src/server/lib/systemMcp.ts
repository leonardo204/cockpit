// packages/feature/agent/src/server/lib/systemMcp.ts
//
// SYSTEM MCP PRESETS — the in-house servers, declared once (skill-hub-builtin §2.1).
//
// An in-house MCP server is an ordinary MCP server. skill-hub is http+headers;
// mcp-atlassian is stdio+env; the runtime loader (src/runtime/mcp.ts) has carried
// both end to end for a long time. So NOTHING HERE IS A NEW TRANSPORT. What is
// new is that the product, not the user, knows the URL, the transport, the header
// name and the env var names — the user knows a token, and maybe their own email
// address.
//
// That is why the general "add an MCP server" form is the wrong door for these.
// It asks for a name, a transport, a URL or a command, and a `Key: Value` block:
// four or five chances to mistype a setup whose answers never vary. A preset
// declares those answers and asks for the one or two values that genuinely differ
// per user.
//
// THIS FILE IS A REGISTRY, NOT A SWITCH. Every surface — the settings rows, the
// onboarding step, the API actions — iterates `SYSTEM_MCP_PRESETS` and branches on
// nothing. A third in-house server is one entry below and zero edits anywhere
// else, which is the whole reason the 0.1.0 skill-hub-only version was generalized
// before it shipped.
//
// PURITY. Everything here is a pure function of its arguments: no store reads, no
// settings, no IO. The two impure inputs a preset can need — a settings URL
// override and the absolute path of a launcher binary (lib/commandPath.ts) — are
// passed IN by the server action, so this module stays trivially testable and the
// policy for those two lives in one visible place.
//
// SECRETS. A preset's secret fields land where MCP secrets already land:
// `payload.headers` for http, `payload.env` for stdio. Both are read back through
// `redactEntry` (api/naby.ts), which keeps KEY NAMES and drops every VALUE. Same
// grade as the Telegram bot token; vault promotion is out of scope (spec §2.5) and
// belongs with app.db encryption.

import { CIC_HARNESS_BUNDLE_ID } from '../../../../../../../dist/naby-runtime.mjs';
import type { McpEntry, Store } from '../../../../../../../dist/naby-runtime.mjs';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One value the USER supplies. Everything else about a preset is a constant. */
export type SystemMcpField = {
  /** Stable id: the key in the `fields` payload and in the stored-value reader. */
  readonly id: string;
  readonly labelKey: string;
  readonly placeholderKey: string;
  /** True when the value must never travel outwards again. A secret is write-only:
   *  blank input on a configured preset means "keep the stored one", exactly like
   *  the Telegram token and the provider API keys. */
  readonly secret: boolean;
};

/** The two things a preset may need from the server that it cannot know itself. */
export type SystemMcpBuildOptions = {
  /** The per-install URL override, already read from settings. Blank = built-in. */
  readonly url?: string;
  /** The absolute path of `preset.launcher`, resolved by the caller at save time.
   *  Absent/blank makes a launcher-bearing preset refuse to build (see §2.1: the
   *  refusal is deliberate — better than an entry that ENOENTs on first use). */
  readonly commandPath?: string;
};

export type SystemMcpBuildResult =
  | { ok: true; entry: McpEntry }
  | {
      ok: false;
      /** English, for logs and for a client with no dictionary. */
      error: string;
      /** i18n key the UI should prefer. */
      errorKey?: string;
      /** The field id an `errorKey` refers to, so the UI can name it in the user's
       *  own language without the server having to translate anything. */
      errorField?: string;
    };

export type SystemMcpPreset = {
  /** The registry name the preset OWNS. The settings row, the general-list filter
   *  and every action key on this one string, so an agent that proposes a server
   *  by the same name through `naby_add_mcp` lands on the preset's row rather than
   *  shadowing it. */
  readonly name: string;
  readonly titleKey: string;
  readonly descriptionKey: string;
  readonly fields: readonly SystemMcpField[];
  /** The external executable a stdio preset spawns, if any. Its absolute path is
   *  resolved at save time and frozen into the entry. */
  readonly launcher?: string;
  /** The built-in endpoint, and the setting key that overrides it per install.
   *  The override is never shown in the UI — it exists for in-house staging. */
  readonly defaultUrl: string;
  readonly urlSettingKey: string;
  /**
   * The BUILT-IN HARNESS BUNDLE this credential switches (skill-hub-builtin §2.7).
   *
   * Some in-house servers ship with harness that is useless without them: the
   * `confluence-context` skill delegates to a subagent whose only tools come from
   * `cic`, so with no cic entry it can do nothing but announce its own failure.
   * Naming the bundle here makes "saving the token is the opt-in" a REGISTRY FACT,
   * so the save/remove actions stay free of per-preset branching — they ask the
   * preset, and the runtime (`applyBuiltinHarnessActivation`) decides what may be
   * flipped and what the user has since claimed as theirs.
   */
  readonly harnessBundle?: string;
  /** Assemble the entry. PURE. */
  build(fields: Record<string, string>, opts?: SystemMcpBuildOptions): SystemMcpBuildResult;
  /** Read the field values back OUT of a stored entry — including secret ones.
   *  Server-only: it is how a save that changed just the email keeps the token
   *  the user is not retyping. The API never returns the secret half; see
   *  `readNonSecretFields`. */
  readStoredFields(entry: McpEntry): Record<string, string>;
};

/** What any surface is ever told about a preset's connection. */
export type SystemMcpStatus = {
  configured: boolean;
  /** Present only when configured. 'proposed' means an AGENT added a server under
   *  this name (`naby_add_mcp`) and it is still waiting on the human approval
   *  every agent-added server waits on — the row shows that state rather than
   *  pretending the server is live. */
  status?: 'enabled' | 'proposed';
  /** Stored values of the NON-SECRET fields, so the form can show what is
   *  configured (an email address) instead of a blank box that implies nothing is.
   *  Secret fields are never in here, by construction (see `readNonSecretFields`).
   *  Absent when there is nothing non-secret to show. */
  nonSecretFields?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// skill-hub — HTTP + Bearer
// ---------------------------------------------------------------------------

export const SKILL_HUB_SERVER_NAME = 'skill-hub';
export const DEFAULT_SKILL_HUB_URL = 'https://skills.altimedia.com/mcp';
export const SKILL_HUB_URL_KEY = 'skillHub.url';

/**
 * Normalize a pasted bearer token.
 *
 * Two things happen to a token between the hub's UI and this function: it picks
 * up whitespace from the copy, and — often enough to be worth handling — it
 * arrives as `Bearer shub_…` because the user copied a whole header line out of
 * some documentation. Prefixing that a second time produces
 * `Bearer Bearer shub_…`, which fails at the server with a 401 that looks like a
 * bad token rather than a bad paste. So the prefix is stripped here and added
 * back exactly once by the preset's `build`.
 */
export function normalizeBearerToken(raw: string): string {
  const trimmed = raw.trim();
  // Case-insensitive, only at the very start, and only on a WORD BOUNDARY: a
  // token whose own body happened to begin with those letters (`bearer_of_keys`)
  // must not be cut. The trailing space is optional rather than required so a
  // paste of the prefix alone normalizes to empty and is rejected as such,
  // instead of being stored as the literal token "Bearer".
  return trimmed.replace(/^bearer\b\s*/i, '').trim();
}

const SKILL_HUB_PRESET: SystemMcpPreset = {
  name: SKILL_HUB_SERVER_NAME,
  titleKey: 'systemMcp.presets.skillHub.title',
  descriptionKey: 'systemMcp.presets.skillHub.description',
  defaultUrl: DEFAULT_SKILL_HUB_URL,
  urlSettingKey: SKILL_HUB_URL_KEY,
  fields: [
    {
      id: 'token',
      labelKey: 'systemMcp.presets.skillHub.fields.token.label',
      placeholderKey: 'systemMcp.presets.skillHub.fields.token.placeholder',
      secret: true,
    },
  ],
  build(fields, opts) {
    const token = normalizeBearerToken(fields.token ?? '');
    // An empty token is refused rather than stored: an entry carrying
    // `Authorization: Bearer ` would read as "configured" in the settings row and
    // then 401 on the first turn, which is the worst of both answers.
    if (!token) return missing('token');
    return {
      ok: true,
      entry: {
        name: SKILL_HUB_SERVER_NAME,
        transport: 'http',
        url: (opts?.url ?? '').trim() || DEFAULT_SKILL_HUB_URL,
        headers: { Authorization: `Bearer ${token}` },
        // A token the user typed IS the approval — 'proposed' exists for servers
        // an AGENT added, not for one a human just pasted a credential into.
        status: 'enabled',
      },
    };
  },
  readStoredFields(entry) {
    if (entry.transport === 'stdio') return {};
    const token = normalizeBearerToken(entry.headers?.Authorization ?? '');
    const out: Record<string, string> = {};
    if (token) out.token = token;
    return out;
  },
};

// ---------------------------------------------------------------------------
// atlassian — stdio (`uvx mcp-atlassian`) + env
// ---------------------------------------------------------------------------

export const ATLASSIAN_SERVER_NAME = 'atlassian';
export const DEFAULT_CONFLUENCE_URL = 'https://altimedia.atlassian.net/wiki';
export const ATLASSIAN_URL_KEY = 'atlassian.confluenceUrl';
/** The launcher. `uvx` runs a published Python tool without installing it, which
 *  is how mcp-atlassian is meant to be started. */
export const ATLASSIAN_LAUNCHER = 'uvx';
export const ATLASSIAN_PACKAGE = 'mcp-atlassian';

/** Deliberately loose: "something@something.something, no spaces". The point is to
 *  catch the paste that was a USERNAME rather than an email (Atlassian's Basic
 *  auth wants the account email and fails with an opaque 401 otherwise), not to
 *  adjudicate RFC 5322. Anything stricter starts rejecting real addresses. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ATLASSIAN_PRESET: SystemMcpPreset = {
  name: ATLASSIAN_SERVER_NAME,
  titleKey: 'systemMcp.presets.atlassian.title',
  descriptionKey: 'systemMcp.presets.atlassian.description',
  defaultUrl: DEFAULT_CONFLUENCE_URL,
  urlSettingKey: ATLASSIAN_URL_KEY,
  launcher: ATLASSIAN_LAUNCHER,
  fields: [
    {
      id: 'username',
      labelKey: 'systemMcp.presets.atlassian.fields.username.label',
      placeholderKey: 'systemMcp.presets.atlassian.fields.username.placeholder',
      // The account email is not a secret and IS shown back: a user who returns
      // to this row a month later should see which account is connected.
      secret: false,
    },
    {
      id: 'apiToken',
      labelKey: 'systemMcp.presets.atlassian.fields.apiToken.label',
      placeholderKey: 'systemMcp.presets.atlassian.fields.apiToken.placeholder',
      secret: true,
    },
  ],
  build(fields, opts) {
    const username = (fields.username ?? '').trim();
    if (!username) return missing('username');
    if (!EMAIL_SHAPE.test(username)) {
      return {
        ok: false,
        error: `"${username}" does not look like an email address; Atlassian authenticates with the account email.`,
        errorKey: 'systemMcp.presets.atlassian.badEmail',
        errorField: 'username',
      };
    }
    const apiToken = (fields.apiToken ?? '').trim();
    if (!apiToken) return missing('apiToken');

    // The absolute path, resolved by the caller. Refusing here is the whole
    // point of the launcher declaration: a `command: 'uvx'` that works in dev
    // and ENOENTs in the packaged app is a bug the user reports as "Confluence
    // stopped working", weeks later and with no way to connect it back.
    const command = (opts?.commandPath ?? '').trim();
    if (!command) {
      return {
        ok: false,
        error: `${ATLASSIAN_LAUNCHER} was not found on this machine. Install uv (https://docs.astral.sh/uv/) and try again.`,
        errorKey: 'systemMcp.uvxMissing',
      };
    }

    return {
      ok: true,
      entry: {
        name: ATLASSIAN_SERVER_NAME,
        transport: 'stdio',
        command,
        args: [ATLASSIAN_PACKAGE],
        env: {
          CONFLUENCE_URL: (opts?.url ?? '').trim() || DEFAULT_CONFLUENCE_URL,
          CONFLUENCE_USERNAME: username,
          CONFLUENCE_API_TOKEN: apiToken,
        },
        status: 'enabled',
      },
    };
  },
  readStoredFields(entry) {
    if (entry.transport !== 'stdio') return {};
    const env = entry.env ?? {};
    const out: Record<string, string> = {};
    if (env.CONFLUENCE_USERNAME) out.username = env.CONFLUENCE_USERNAME;
    if (env.CONFLUENCE_API_TOKEN) out.apiToken = env.CONFLUENCE_API_TOKEN;
    return out;
  },
};

// ---------------------------------------------------------------------------
// cic — HTTP + Bearer, and the switch for the built-in Confluence bundle
// ---------------------------------------------------------------------------
//
// CIC is the in-house Confluence index: `find_docs` locates pages, `read_section`
// pulls one section's body, `search_cql` is the fallback when the index is not
// built yet, `submit_feedback` closes the rating loop. Transport-wise it is the
// same shape as skill-hub — HTTP plus a bearer token — which is why this preset is
// a near-copy and not a new mechanism.
//
// THE SERVER NAME IS LOAD-BEARING: IT MUST BE `cic`.
//
// The built-in `confluence-researcher` subagent (src/runtime/harness-assets/agents/
// confluence-researcher.md) declares `tools: mcp__cic__find_docs, ...`, and naby
// namespaces every MCP tool as `<server>__<tool>` (src/runtime/mcp.ts
// `qualifiedToolName`). So the subagent's allow-list only resolves to real tools
// while THIS ENTRY IS NAMED `cic`. Rename the preset and the subagent silently runs
// with an EMPTY toolset — it still answers, it just answers "I could not research
// Confluence", which is the failure mode hardest to trace back to a name. The
// shell's `restrictToolset` (lib/delegation.ts) is what bridges Claude's
// `mcp__<server>__<tool>` spelling to naby's `<server>__<tool>`; it does not, and
// must not, guess at the server half.
//
// SAVING A TOKEN HERE IS ALSO THE OPT-IN FOR THE BUILT-IN HARNESS BUNDLE — see
// `harnessBundle` below and src/runtime/harness-seed.ts.

export const CIC_SERVER_NAME = 'cic';
export const DEFAULT_CIC_URL = 'https://skills.altimedia.com/cic/mcp';
export const CIC_URL_KEY = 'cic.url';

const CIC_PRESET: SystemMcpPreset = {
  name: CIC_SERVER_NAME,
  titleKey: 'systemMcp.presets.cic.title',
  descriptionKey: 'systemMcp.presets.cic.description',
  defaultUrl: DEFAULT_CIC_URL,
  urlSettingKey: CIC_URL_KEY,
  // The bundle this credential switches on. Declared HERE so `api/naby.ts` keeps
  // its no-per-preset-branching property: it asks the registry whether the preset
  // it just saved owns a bundle, and never asks "is this cic".
  harnessBundle: CIC_HARNESS_BUNDLE_ID,
  fields: [
    {
      id: 'token',
      labelKey: 'systemMcp.presets.cic.fields.token.label',
      placeholderKey: 'systemMcp.presets.cic.fields.token.placeholder',
      secret: true,
    },
  ],
  build(fields, opts) {
    const token = normalizeBearerToken(fields.token ?? '');
    if (!token) return missing('token');
    return {
      ok: true,
      entry: {
        name: CIC_SERVER_NAME,
        transport: 'http',
        url: (opts?.url ?? '').trim() || DEFAULT_CIC_URL,
        headers: { Authorization: `Bearer ${token}` },
        status: 'enabled',
      },
    };
  },
  readStoredFields(entry) {
    if (entry.transport === 'stdio') return {};
    const token = normalizeBearerToken(entry.headers?.Authorization ?? '');
    const out: Record<string, string> = {};
    if (token) out.token = token;
    return out;
  },
};

/** "This field has no value" — one shape for every preset, so the UI renders the
 *  same sentence with the field's own label whichever preset raised it. */
function missing(field: string): SystemMcpBuildResult {
  return {
    ok: false,
    error: `the "${field}" field is required`,
    errorKey: 'systemMcp.fieldRequired',
    errorField: field,
  };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** Every built-in preset, in the order the UI stacks them. */
export const SYSTEM_MCP_PRESETS: readonly SystemMcpPreset[] = [
  SKILL_HUB_PRESET,
  ATLASSIAN_PRESET,
  CIC_PRESET,
];

/** The names a preset owns — what the general MCP list filters out, so a preset's
 *  entry is never shown twice (once with the URL and header block the preset
 *  exists to hide, and once without). */
export const SYSTEM_MCP_PRESET_NAMES: readonly string[] = SYSTEM_MCP_PRESETS.map((p) => p.name);

export function findSystemMcpPreset(name: string): SystemMcpPreset | undefined {
  return SYSTEM_MCP_PRESETS.find((p) => p.name === name);
}

/** The endpoint this install should use for a preset: the settings override when
 *  set, otherwise the built-in constant. One reader for the setting key. */
export function readPresetUrl(store: Pick<Store, 'getSetting'>, preset: SystemMcpPreset): string {
  return store.getSetting(preset.urlSettingKey)?.trim() || preset.defaultUrl;
}

/** The subset of a stored entry's field values that is safe to hand the UI. Built
 *  by FILTERING the single reader rather than by a second reader, so a field that
 *  is later marked secret stops being returned everywhere at once. */
export function readNonSecretFields(
  preset: SystemMcpPreset,
  entry: McpEntry,
): Record<string, string> {
  const stored = preset.readStoredFields(entry);
  const out: Record<string, string> = {};
  for (const field of preset.fields) {
    if (field.secret) continue;
    const value = stored[field.id];
    if (value) out[field.id] = value;
  }
  return out;
}

/**
 * IS THIS PRESET CONNECTED — asked in ONE place, for every preset at once.
 *
 * The settings rows, the onboarding step and the GET state all need this answer,
 * and a second function that re-derived it from a redacted entry list would be the
 * sibling of the `isClaudeAgentSdkAvailable` duplication the project already paid
 * for: two answers to one question, with the UI trusting the wrong one.
 */
export function readSystemMcpStatus(
  store: Pick<Store, 'listMcpEntries'>,
): Record<string, SystemMcpStatus> {
  const entries = store.listMcpEntries();
  const out: Record<string, SystemMcpStatus> = {};
  for (const preset of SYSTEM_MCP_PRESETS) {
    const entry = entries.find((e) => e.name === preset.name);
    if (!entry) {
      out[preset.name] = { configured: false };
      continue;
    }
    const nonSecret = readNonSecretFields(preset, entry);
    out[preset.name] = {
      configured: true,
      status: entry.status === 'proposed' ? 'proposed' : 'enabled',
      ...(Object.keys(nonSecret).length > 0 ? { nonSecretFields: nonSecret } : {}),
    };
  }
  return out;
}

/**
 * The field values a save should build from: what is stored, overlaid with what
 * the user just typed.
 *
 * BLANK MEANS KEEP. A configured preset shows a secret field as an empty password
 * box (the value has no way back out of the server), so an empty string there is
 * "I did not retype my token", never "clear my token". Without this merge, editing
 * the Atlassian email would silently wipe the API token — the exact failure the
 * one-field 0.1.0 version could not have.
 */
export function mergeSystemMcpFields(
  preset: SystemMcpPreset,
  existing: McpEntry | undefined,
  incoming: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = existing ? { ...preset.readStoredFields(existing) } : {};
  for (const field of preset.fields) {
    const value = incoming[field.id];
    if (typeof value !== 'string') continue;
    if (!value.trim()) continue;
    merged[field.id] = value;
  }
  return merged;
}
