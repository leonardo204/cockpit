/**
 * THE SYSTEM MCP PRESETS, AS THE RENDERER SEES THEM (skill-hub-builtin §2.1).
 *
 * The registry itself lives on the server
 * (`@cockpit/feature-agent/server/lib/systemMcp`), because that is where entries
 * are assembled and where the secrets are. This is the half a client bundle needs
 * — a name, three i18n keys per field, and which fields are secret — mirrored for
 * the same reason `CHATGPT_OAUTH_KIND` is a literal in NabyProviderSetup.tsx: the
 * server module imports the runtime bundle, so pulling it into the browser build
 * would drag `node:sqlite` in behind it.
 *
 * THE MIRROR IS NOT TRUSTED TO STAY IN STEP BY GOODWILL. `systemMcpPresets.test.ts`
 * imports both and asserts they describe the same presets, the same fields, the
 * same secrecy and the same keys — so a preset added or a field renamed on the
 * server fails the suite here rather than rendering a form the server rejects.
 *
 * NOTHING SECRET, AND NOTHING ASSEMBLED, IS IN THIS FILE. No URL, no command, no
 * header or env names: the client posts field values by id and the server decides
 * what they mean.
 */

export type SystemMcpFieldView = {
  id: string;
  labelKey: string;
  placeholderKey: string;
  /** Rendered as a password box that starts blank on every open, and whose empty
   *  value means "keep what is stored" rather than "clear it". */
  secret: boolean;
};

export type SystemMcpPresetView = {
  /** The registry name — the `preset` argument of every `systemMcp.*` action, and
   *  the entry name filtered out of the general MCP list. */
  name: string;
  titleKey: string;
  descriptionKey: string;
  fields: SystemMcpFieldView[];
};

export const SYSTEM_MCP_PRESETS: readonly SystemMcpPresetView[] = [
  {
    name: 'skill-hub',
    titleKey: 'systemMcp.presets.skillHub.title',
    descriptionKey: 'systemMcp.presets.skillHub.description',
    fields: [
      {
        id: 'token',
        labelKey: 'systemMcp.presets.skillHub.fields.token.label',
        placeholderKey: 'systemMcp.presets.skillHub.fields.token.placeholder',
        secret: true,
      },
    ],
  },
  {
    name: 'atlassian',
    titleKey: 'systemMcp.presets.atlassian.title',
    descriptionKey: 'systemMcp.presets.atlassian.description',
    fields: [
      {
        id: 'username',
        labelKey: 'systemMcp.presets.atlassian.fields.username.label',
        placeholderKey: 'systemMcp.presets.atlassian.fields.username.placeholder',
        secret: false,
      },
      {
        id: 'apiToken',
        labelKey: 'systemMcp.presets.atlassian.fields.apiToken.label',
        placeholderKey: 'systemMcp.presets.atlassian.fields.apiToken.placeholder',
        secret: true,
      },
    ],
  },
];

/** The names the general MCP list must filter out, so a preset's entry is never
 *  shown twice — once with the URL/command and secret block the preset exists to
 *  hide, and once without. */
export const SYSTEM_MCP_PRESET_NAMES: readonly string[] = SYSTEM_MCP_PRESETS.map((p) => p.name);

/** What the server says about one preset's connection (`systemMcp` on the GET). */
export type SystemMcpStatus = {
  configured: boolean;
  status?: 'enabled' | 'proposed';
  /** Stored values of the fields marked NON-secret, so the form shows which
   *  account is connected instead of a blank box. Secrets are never in here. */
  nonSecretFields?: Record<string, string>;
};
