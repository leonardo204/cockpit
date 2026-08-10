import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE SESSION MODEL CHIP, FOR GEMINI.
 *
 * `modelCatalog.test.ts` pins the decisions (which scopes exist, what an empty
 * live list means). This pins the WIRING inside the component, which is the part
 * that cannot be reached without a React renderer — and one detail of it is a
 * genuine trap rather than a style point:
 *
 *   CLAUDE LOADS ITS LIST WHEN THE MENU OPENS. Gemini cannot. Claude has a
 *   curated fallback, so its chip renders (and can be clicked) before any answer
 *   arrives; Gemini has none, so an empty list renders NO chip — and a chip that
 *   never renders can never be opened to trigger the load that would fill it.
 *   The list therefore has to be asked for on the scope change instead.
 *
 * The chip also never sees a key: it posts `models.list` and the server resolves
 * the credential.
 */

const SOURCE = readFileSync(join(__dirname, 'ModelSwitcher.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

describe('ModelSwitcher — the Gemini catalog', () => {
  it('loads on the SCOPE CHANGE, not only when the menu opens', () => {
    expect(SOURCE).toMatch(
      /useEffect\(\(\) => \{\s*if \(scope === GOOGLE_MODEL_SCOPE\) void loadModels\(false\);\s*\}, \[scope, loadModels\]\);/,
    );
    // The menu-open load stays for Claude.
    expect(SOURCE).toMatch(/if \(open\) void loadModels\(false\);/);
  });

  it('asks for the Google catalog by name', () => {
    expect(SOURCE).toContain(
      "...(scope === GOOGLE_MODEL_SCOPE ? { provider: GOOGLE_MODEL_SCOPE } : {}),",
    );
  });

  it('keeps the shown list when a lookup comes back empty', () => {
    // "No key yet" and "the network blinked" both answer empty; blanking a picker
    // the user is looking at is the wrong response to either.
    expect(SOURCE).toMatch(/if \(Array\.isArray\(list\) && list\.length > 0\) setLiveGoogle\(list\);/);
  });

  it('offers refresh for every live catalog, with its own explanation', () => {
    expect(SOURCE).toContain('{scopeHasLiveCatalog(scope) && (');
    expect(SOURCE).toContain("t('modelSwitcher.refreshHintGoogle'");
  });

  it('never touches a credential', () => {
    expect(SOURCE).not.toMatch(/apiKey|api_key|x-goog-api-key/);
  });
});
