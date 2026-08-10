import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TWO THINGS THE SETTINGS "AI PROVIDER" SECTION HAS TO DO, asserted against the
 * source.
 *
 * Source assertions rather than mounted ones, for the same reason as
 * `settingsLayout.test.ts`: there is no React renderer in this suite, and both
 * facts below are about WIRING — which callback a child is handed, which values
 * an effect re-runs on — that a snapshot of markup could not see anyway.
 *
 *   1. SAVING A KEY UPDATES "WHICH MODEL ANSWERS" (task 2). The key accordion and
 *      the engine selector read two different sources: the preload bridge
 *      (keychain) and /api/naby (server). Only the first was re-read after a
 *      save, so a user who saved a Gemini key with Settings open saw "key saved"
 *      on the row and an unchanged list above it. The chat header's switcher
 *      always looked right because it polls — which is exactly why the bug read
 *      as "it only fails in Settings".
 *
 *   2. GEMINI'S MODEL IS A LIST, NOT A STRING TO KNOW (task 3). One Google key
 *      opens the whole catalog, so the form offers the live list beside the text
 *      box — WITHOUT ever making the list a gate: the box still accepts any id,
 *      so a model released this morning is usable this morning.
 *
 * THE SECURITY LINE runs through both: the model list is fetched by the SERVER,
 * which resolves the stored key itself. Nothing here may send a key anywhere.
 */

const DIR = __dirname;

/** The source with comments stripped — this file's own explanations name the
 *  very strings it asserts are absent (`setInterval`, `key`), so a naive scan
 *  would read the prose as code. */
const read = (f: string) =>
  readFileSync(join(DIR, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const SETUP = read('NabyProviderSetup.tsx');

const dict = (locale: string): Record<string, Record<string, string>> =>
  JSON.parse(
    readFileSync(join(DIR, '../../../..', 'shared/i18n/locales', `${locale}.json`), 'utf8'),
  );

describe('the engine selector re-reads when a key is saved', () => {
  it('every NabyEngineSelector is given the refresh token', () => {
    const mounts = SETUP.match(/<NabyEngineSelector[^/]*\/>/g) ?? [];
    // Both the ordinary section and the "no desktop bridge" branch.
    expect(mounts.length).toBeGreaterThanOrEqual(2);
    for (const mount of mounts) expect(mount).toContain('refreshToken={savedTick}');
  });

  it('the selector actually re-fetches on it (it is in the effect deps)', () => {
    // The bug in one line: the effect used to be `[isOpen, reload]`, so nothing a
    // sibling did could make it ask again.
    expect(SETUP).toMatch(/\}, \[isOpen, reload, refreshToken\]\);/);
  });

  it('a save bumps the token as well as reloading the key list', () => {
    expect(SETUP).toMatch(/const onSaved = useCallback\(\(\) => \{\s*void reload\(\);\s*setSavedTick/);
    // …and the form in the settings section is handed THAT callback, not an
    // inline reload that would only refresh half the screen.
    expect(SETUP).toContain('<ProviderForm row={row} onSaved={onSaved} autoFocus />');
  });

  it('adds no polling — a save is an unambiguous signal', () => {
    expect(SETUP).not.toContain('setInterval');
  });
});

describe('the Gemini model field', () => {
  it('offers the live list AND keeps free typing', () => {
    // The text input is the source of truth; the picker only writes into it.
    expect(SETUP).toContain('data-testid={`provider-model-${row.kind}`}');
    expect(SETUP).toContain('data-testid="provider-model-list"');
    expect(SETUP).toContain('data-testid="provider-model-refresh"');
    // The select's onChange sets the SAME state the box edits, so a typed id and
    // a picked id are indistinguishable downstream.
    expect(SETUP).toMatch(/if \(e\.target\.value\) setModel\(e\.target\.value\);/);
  });

  it('shows the list only for Google, whose one key opens a catalog', () => {
    expect(SETUP).toContain("const GOOGLE_KIND = 'google'");
    expect(SETUP).toContain('{row.kind === GOOGLE_KIND && (');
    expect(SETUP).toMatch(/if \(row\.kind !== GOOGLE_KIND\) return;/);
  });

  it('asks the SERVER for the list, and sends no key of its own', () => {
    expect(SETUP).toMatch(/action: 'models\.list',\s*provider: GOOGLE_KIND,/);
    // The request carries the action, the provider and a refresh flag. If a key
    // ever appears in this body, the credential has left the main process.
    const call = SETUP.slice(SETUP.indexOf("action: 'models.list'"));
    expect(call.slice(0, 200)).not.toMatch(/\bkey\b/);
  });

  it('reports refreshing and failure to the user', () => {
    expect(SETUP).toContain("t('providerSetup.modelRefreshing')");
    expect(SETUP).toContain("t('providerSetup.modelListEmpty')");
    for (const locale of ['en', 'ko']) {
      const d = dict(locale);
      for (const key of ['modelChoose', 'modelRefresh', 'modelRefreshing', 'modelListEmpty']) {
        expect(d.providerSetup?.[key], `${locale}.providerSetup.${key}`).toBeTruthy();
      }
    }
  });

  it('the failure copy tells the user they can still type an id themselves', () => {
    // The one thing that must never be lost: a stale list may not block a new
    // model. Both languages say so.
    expect(dict('en').providerSetup!.modelListEmpty).toMatch(/type a model id/i);
    expect(dict('ko').providerSetup!.modelListEmpty).toContain('직접 입력');
  });
});
