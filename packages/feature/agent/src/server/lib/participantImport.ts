// packages/feature/agent/src/server/lib/participantImport.ts
//
// PARTICIPANT IMPORT / EXPORT — the shell half of MAC-M4 (specs/agent-import-
// adapters.md, multi-agent-chat §8.4).
//
// The runtime owns the adapters and every trust rule (`src/runtime/import/`):
// what a file may claim, what it never may, which tools survive, the size caps,
// provenance. This module owns only what the runtime cannot know:
//
//   * WHAT THIS MACHINE HAS — the tool catalogue, the registered MCP servers, the
//     enabled skills — so the pipeline can keep only what matches (§4 step 3);
//   * the user's DECISIONS from the preview (a better description, a display
//     name, a different handle) and the participant name rule they must pass;
//   * decoding the upload, with a size cap.
//
// Pure apart from the narrow store slices it is handed.

import {
  buildParticipantBundle,
  buildParticipantExport,
  DEFAULT_USER_ID,
  importParticipant,
  resolvePermissionTools,
  runtimeToolNames,
  toolTierOf,
  type Agent,
  type ImportEnv,
  type ImportFormat,
  type ImportPlan,
  type ParticipantBundle,
  type ParticipantExportResult,
  type Store,
  type ToolTier,
} from '../../../../../../../dist/naby-runtime.mjs';
import { PARTICIPANT_EXCLUDED_TOOLS } from './participantTurn';
import { validateParticipantName } from './participants';

/** The org scope key the engine and the slash palette read harness rows under. */
const DEFAULT_ORG_ID = 'default';

/** An upload larger than this is refused before it is decoded. A card PNG with
 *  a portrait is hundreds of KB; nothing a participant can hold is near this. */
export const PARTICIPANT_IMPORT_MAX_BYTES = 8 * 1024 * 1024;

/** Formats the action accepts in `format` (the ones with an adapter). */
export const IMPORTABLE_FORMATS: readonly ImportFormat[] = [
  'claude-agent-md',
  'naby-sidecar',
  'character-card-v2',
  'character-card-v3',
];

/**
 * The tools a participant can be granted on this machine: naby's runtime tools,
 * built by the same builders a turn uses (`runtimeToolNames`), minus the ones a
 * participant never gets (naby's learning / check-in / delegation — R3.8, §8.9).
 * MCP tools are not listed by name (that needs a live connection); they are
 * granted per server through `profile.mcpServers`.
 */
export function participantToolCatalog(): string[] {
  return runtimeToolNames().filter((n) => !PARTICIPANT_EXCLUDED_TOOLS.has(n));
}

/**
 * Each catalogue tool's permission tier (§8.14, MAC-M7) — what the editor's
 * "show included tools" lists under each level. Judged by `toolTierOf`, the same
 * function the gate resolves a level with, so the list and the gate agree.
 */
export function participantToolTiers(): Record<string, ToolTier> {
  const out: Record<string, ToolTier> = {};
  for (const name of participantToolCatalog()) out[name] = toolTierOf(name);
  return out;
}

/**
 * The catalogue tools each permission level includes (§8.14) — the editor's
 * "show included tools" list, resolved by the same `resolvePermissionTools` a
 * turn's gate applies, so the client never decides a level itself. MCP tools are
 * not here (they need a live connection); the editor says how they join.
 */
export function participantToolsByLevel(): Record<'none' | 'read' | 'write' | 'elevated' | 'all', string[]> {
  const names = participantToolCatalog();
  return {
    none: [],
    read: resolvePermissionTools({ level: 'read' }, names),
    write: resolvePermissionTools({ level: 'write' }, names),
    elevated: resolvePermissionTools({ level: 'elevated' }, names),
    all: resolvePermissionTools({ level: 'all' }, names),
  };
}

/** Registered MCP server names, minus agent-proposed ones nobody approved. */
export function registeredMcpServerNames(store: Pick<Store, 'listMcpEntries'>): string[] {
  try {
    return store
      .listMcpEntries()
      .filter((m) => (m as { status?: string }).status !== 'proposed')
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
  } catch {
    return [];
  }
}

/** Enabled skill names across the scopes a turn reads (user, org, the project). */
export function enabledSkillNames(store: Pick<Store, 'listHarness'>, cwd?: string): string[] {
  const out = new Set<string>();
  const read = (scope: 'user' | 'org' | 'project', key: string) => {
    try {
      for (const it of store.listHarness(scope, key, { kind: 'skill', status: 'enabled' })) out.add(it.name);
    } catch {
      /* a scope that cannot be read offers nothing */
    }
  };
  read('user', DEFAULT_USER_ID);
  read('org', DEFAULT_ORG_ID);
  if (cwd) read('project', cwd);
  return [...out].sort();
}

/** What `finalizePlan` compares a file's tools, servers and skills against. */
export function participantImportEnv(
  store: Pick<Store, 'listMcpEntries' | 'listHarness'>,
  cwd?: string,
): ImportEnv {
  return {
    installedTools: participantToolCatalog(),
    mcpServers: registeredMcpServerNames(store),
    skills: enabledSkillNames(store, cwd),
  };
}

/** Base64 → bytes, or an error sentence. */
export function decodeImportBytes(b64: unknown): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
  if (typeof b64 !== 'string' || !b64.trim()) return { ok: false, error: 'bytesBase64 is required' };
  // 4 base64 characters carry 3 bytes — refuse before allocating.
  if (Math.floor((b64.length * 3) / 4) > PARTICIPANT_IMPORT_MAX_BYTES + 3) {
    return { ok: false, error: `the file is larger than ${PARTICIPANT_IMPORT_MAX_BYTES / (1024 * 1024)} MB` };
  }
  const clean = b64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) return { ok: false, error: 'bytesBase64 is not base64' };
  const bytes = new Uint8Array(Buffer.from(clean, 'base64'));
  if (bytes.length === 0) return { ok: false, error: 'the file is empty' };
  return { ok: true, bytes };
}

/** What the user changed in the preview. */
export type ParticipantImportDecisions = { name?: string; displayName?: string; description?: string };

export function readDecisions(raw: unknown): ParticipantImportDecisions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: ParticipantImportDecisions = {};
  if (typeof o.name === 'string' && o.name.trim()) out.name = o.name.trim();
  if (typeof o.displayName === 'string' && o.displayName.trim()) out.displayName = o.displayName.trim();
  if (typeof o.description === 'string') out.description = o.description;
  return out;
}

/** Parse a file into a plan, against this machine as it is right now. */
export function planParticipantImport(
  store: Pick<Store, 'listAgents' | 'listMcpEntries' | 'listHarness'>,
  input: { fileName: string; bytes: Uint8Array; format?: ImportFormat; cwd?: string; now: number },
): { ok: true; plan: ImportPlan } | { ok: false; problems: string[] } {
  return importParticipant(
    {
      fileName: input.fileName,
      bytes: input.bytes,
      now: input.now,
      // Read fresh on EVERY call — the apply re-parses, so a name taken between
      // the preview and the apply is still seen.
      existingNames: store.listAgents().map((a) => a.name),
    },
    { ...(input.format ? { format: input.format } : {}), env: participantImportEnv(store, input.cwd) },
  );
}

/**
 * The user's decisions on top of the plan, then the participant name rule
 * (`validateParticipantName`: reserved hub names, case-insensitive uniqueness,
 * the `@`-handle shape). A typed name that is taken is an ERROR (the user chose
 * it); the plan's own name was already freed by the pipeline.
 */
export function applyImportDecisions(
  plan: ImportPlan,
  decisions: ParticipantImportDecisions,
  store: Pick<Store, 'getAgentByName' | 'listAgents'>,
): { ok: true; agent: ImportPlan['agent'] } | { ok: false; error: string } {
  const named = validateParticipantName(decisions.name ?? plan.agent.name, store);
  if (!named.ok) return { ok: false, error: named.error };
  const description = decisions.description !== undefined ? decisions.description.trim() : plan.agent.description;
  const { description: _old, ...rest } = plan.agent;
  return {
    ok: true,
    agent: {
      ...rest,
      name: named.name,
      ...(description ? { description } : {}),
      profile: {
        ...plan.agent.profile,
        ...(decisions.displayName ? { displayName: decisions.displayName } : {}),
      },
    },
  };
}

/** `participant.export` — the `.md` + sidecar v2 pair for one participant. */
export function exportParticipant(agent: Agent, now: number): ParticipantExportResult {
  return buildParticipantExport({ agent, now });
}

/** `participant.exportBundle` — several participants in one zip, base64. */
export function exportParticipantBundle(
  agents: readonly Agent[],
  now: number,
): Omit<ParticipantBundle, 'bytes'> & { base64: string } {
  const b = buildParticipantBundle(agents, now);
  return { fileName: b.fileName, manifest: b.manifest, reports: b.reports, base64: Buffer.from(b.bytes).toString('base64') };
}
