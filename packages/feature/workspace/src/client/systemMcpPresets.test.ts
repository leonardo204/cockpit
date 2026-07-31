import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_MCP_PRESETS, SYSTEM_MCP_PRESET_NAMES } from './systemMcpPresets';
import { SYSTEM_MCP_PRESETS as SERVER_PRESETS } from '@cockpit/feature-agent/server/lib/systemMcp';

/**
 * THE CLIENT MIRROR MATCHES THE SERVER REGISTRY (skill-hub-builtin §2.1).
 *
 * The renderer cannot import the server registry (it imports the runtime bundle,
 * and with it `node:sqlite`), so the presentational half is mirrored in
 * `systemMcpPresets.ts`. A mirror that drifts is worse than no mirror: the form
 * would ask for a field the server does not accept, or render a preset name no
 * action recognises, and both fail at the moment the user presses Connect.
 *
 * So the two are compared here, in a node test that CAN import both.
 */

describe('the client preset mirror', () => {
  it('lists the same presets, in the same order', () => {
    expect(SYSTEM_MCP_PRESET_NAMES).toEqual(SERVER_PRESETS.map((p) => p.name));
  });

  it('mirrors every preset field: id, secrecy and i18n keys', () => {
    // Projected rather than compared whole: the server preset also carries
    // `build`, `readStoredFields`, the URL constants and the launcher, none of
    // which a client bundle may see.
    const projected = SERVER_PRESETS.map((p) => ({
      name: p.name,
      titleKey: p.titleKey,
      descriptionKey: p.descriptionKey,
      fields: p.fields.map((f) => ({
        id: f.id,
        labelKey: f.labelKey,
        placeholderKey: f.placeholderKey,
        secret: f.secret,
      })),
    }));
    expect(SYSTEM_MCP_PRESETS).toEqual(projected);
  });

  it('mirrors NOTHING the server decides', () => {
    // The point of the preset is that the client does not know the endpoint, the
    // command or the header/env names. If any of them appeared here, the mirror
    // would have become a second source of truth for the entry itself.
    const source = readFileSync(join(__dirname, 'systemMcpPresets.ts'), 'utf8');
    for (const secretish of [
      'skills.altimedia.com',
      'atlassian.net',
      'uvx',
      'Authorization',
      'CONFLUENCE_',
    ]) {
      expect(source, `${secretish} leaked into the client mirror`).not.toContain(secretish);
    }
  });

  it('keeps every i18n key in the systemMcp namespace', () => {
    for (const preset of SYSTEM_MCP_PRESETS) {
      expect(preset.titleKey.startsWith('systemMcp.')).toBe(true);
      expect(preset.descriptionKey.startsWith('systemMcp.')).toBe(true);
      for (const field of preset.fields) {
        expect(field.labelKey.startsWith('systemMcp.')).toBe(true);
        expect(field.placeholderKey.startsWith('systemMcp.')).toBe(true);
      }
    }
  });
});

describe('the i18n dictionaries answer every key the presets name', () => {
  const dict = (locale: string) =>
    JSON.parse(
      readFileSync(
        join(__dirname, '../../../../shared/i18n/locales', `${locale}.json`),
        'utf8',
      ),
    ) as Record<string, unknown>;

  const lookup = (source: Record<string, unknown>, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => {
      if (!node || typeof node !== 'object') return undefined;
      return (node as Record<string, unknown>)[part];
    }, source);

  for (const locale of ['en', 'ko']) {
    it(`${locale} translates every preset title, description and field`, () => {
      // A missing key renders the key itself to the user — "systemMcp.presets.
      // atlassian.title" in the middle of Settings. The registry is the list of
      // what must exist, so a preset added without copy fails here.
      const source = dict(locale);
      for (const preset of SYSTEM_MCP_PRESETS) {
        expect(lookup(source, preset.titleKey), `${locale}: ${preset.titleKey}`).toBeTypeOf('string');
        expect(
          lookup(source, preset.descriptionKey),
          `${locale}: ${preset.descriptionKey}`,
        ).toBeTypeOf('string');
        for (const field of preset.fields) {
          expect(lookup(source, field.labelKey), `${locale}: ${field.labelKey}`).toBeTypeOf('string');
          expect(
            lookup(source, field.placeholderKey),
            `${locale}: ${field.placeholderKey}`,
          ).toBeTypeOf('string');
        }
      }
    });

    it(`${locale} carries the shared System MCP copy`, () => {
      const source = dict(locale);
      for (const key of [
        'systemMcp.title',
        'systemMcp.description',
        'systemMcp.connect',
        'systemMcp.connecting',
        'systemMcp.test',
        'systemMcp.remove',
        'systemMcp.connected',
        'systemMcp.notConfigured',
        'systemMcp.proposed',
        'systemMcp.proposedHint',
        'systemMcp.approve',
        'systemMcp.toolCount',
        'systemMcp.failed',
        'systemMcp.fieldRequired',
        'systemMcp.secretKept',
        'systemMcp.uvxMissing',
        'systemMcp.onboardingTitle',
        'systemMcp.onboardingBody',
        'systemMcp.later',
        'systemMcp.changeLater',
      ]) {
        expect(lookup(source, key), `${locale}: ${key}`).toBeTypeOf('string');
      }
      // The 0.1.0 namespace is gone, not merely unused — a stale block would be
      // copy nobody maintains and the next reader would not know which is live.
      expect(source.skillHub).toBeUndefined();
    });
  }
});
