import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every harness mutation announces itself.
 *
 * The other half of the "'/' never sees a newly enabled skill" fix. The composer
 * now listens (`harnessSignal.test.ts` covers that end and the round trip); this
 * file defends the PUBLISHER, which is the half that rots. Each mutation here is
 * a separate `post(...)` call written months apart, and adding a fifth one
 * without the announcement reintroduces the original bug for that action alone —
 * silently, because the panel's own list still refreshes from its `reload()` and
 * looks entirely correct. Only the other frame is wrong.
 *
 * Source assertions rather than a render, for the reason `settingsLayout.test.ts`
 * gives: this suite has no jsdom, and the thing being checked is which call sites
 * exist, not what they paint.
 */

/** Source with comments stripped — these files explain the announcement in
 *  prose, and a naive scan would count those sentences as call sites. */
const read = (f: string) =>
  readFileSync(join(__dirname, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/** The shared announcement helper. */
const HELPER = read('harnessChanged.ts');

/** The two panels that mutate the harness. Both feed the same "/" palette, and
 *  the palette bug was fixed in the first one while the second kept it — which
 *  is precisely why the list is spelled out rather than assumed. */
const PANELS = {
  'NabyHarnessReview.tsx': ['runRowAction', 'runImport', 'doImport', 'revertImport'],
  'NabyCommandManager.tsx': ['submitDraft', 'runRowAction'],
} as const;

/**
 * The body of `const <name> = useCallback( … )`, delimited by matching
 * parentheses.
 *
 * Paren matching rather than "up to the next declaration": `doImport` is the
 * last callback in its component, so a next-declaration scan would run to the
 * end of the file and happily find an announcement belonging to some other
 * function. String and template literals are skipped so a `'('` inside copy
 * cannot unbalance the count.
 */
function callbackBody(src: string, name: string): string {
  const anchor = `const ${name} = useCallback(`;
  const at = src.indexOf(anchor);
  if (at === -1) return '';
  const open = at + anchor.length - 1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return '';
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('the announcement is defined once, in one place', () => {
  it('announces through the topic, not a hand-rolled postMessage', () => {
    // A literal `postMessage({ type: 'HARNESS_CHANGED' })` would work today and
    // drift the moment the topic's legacy type is renamed — the topics table
    // exists so a rename is a compile error rather than a dead listener.
    expect(HELPER).toContain("import { Topics } from '@cockpit/effect-services'");
    expect(HELPER).toContain('Topics.HarnessChanged');
    expect(HELPER).not.toContain('HARNESS_CHANGED');
  });

  it('announces in BOTH directions', () => {
    // `publishTopic` alone posts to window.parent, which from the top window —
    // where these panels render — is the window it was sent from. The child
    // iframes, i.e. every composer, would never hear it. That single detail is
    // the whole bug.
    expect(HELPER).toContain('announceTopic(Topics.HarnessChanged');
    expect(HELPER).not.toMatch(/\bpublishTopic\(/);
  });

  it('is the ONLY place that publishes the topic', () => {
    // Two panels mutate the harness and there will be a third. Each one inlining
    // the broadcast is exactly how the command panel came to be missing it while
    // the review panel had it.
    expect(HELPER).toMatch(/export function announceHarnessChanged\(\): void/);
    expect(occurrences(HELPER, 'announceTopic(')).toBe(1);
    for (const file of Object.keys(PANELS)) {
      expect(read(file), `${file} publishes the topic itself`).not.toContain('announceTopic(');
    }
  });
});

describe('each mutation that changes visibility announces', () => {
  for (const [file, callbacks] of Object.entries(PANELS)) {
    const src = read(file);

    it(`${file} imports the shared helper`, () => {
      expect(src).toContain("from './harnessChanged'");
    });

    for (const name of callbacks) {
      it(`${file}: ${name} announces`, () => {
        const body = callbackBody(src, name);
        expect(body, `${name} not found in ${file} — was it renamed?`).toBeTruthy();
        expect(body).toContain('announceHarnessChanged()');
      });
    }

    it(`${file} announces only on success`, () => {
      // Announcing from a `finally` would refetch after a failed action too —
      // harmless in itself, but it hides a broken mutation behind a refresh that
      // appears to have done something.
      for (const name of callbacks) {
        const body = callbackBody(src, name);
        const announceAt = body.indexOf('announceHarnessChanged()');
        const okAt = body.indexOf('res.ok');
        expect(okAt, `${name}: no success branch found`).toBeGreaterThan(-1);
        expect(announceAt, `${name}: announces outside the success branch`).toBeGreaterThan(okAt);
      }
    });

    it(`${file} does not announce from a read`, () => {
      // `reload()` runs on every scope switch and every open of the modal.
      expect(callbackBody(src, 'reload')).not.toContain('announceHarnessChanged()');
    });
  }

  it('covers every mutating action the panels can send', () => {
    // THE BACKSTOP for the hand-written list above. A panel that learns a new
    // write action — the way `importSet` was added long after `import` — must
    // fail here rather than ship a silent hole for that one action.
    //
    // Actions that do not change what the harness contains are excluded by name:
    // `exportSet` reads a scope into a downloadable file and mutates nothing.
    const NON_MUTATING = new Set(['exportSet']);

    for (const file of Object.keys(PANELS)) {
      const src = read(file);

      // Every `const x = useCallback(` in the file, not just the listed ones —
      // an action sent from an unlisted callback is exactly what this catches.
      const names = [...src.matchAll(/const (\w+) = useCallback\(/g)].map((m) => m[1]!);
      const bodies = new Map(names.map((n) => [n, callbackBody(src, n)]));

      // A callback covers an action if it announces itself, or if it hands the
      // request to one that does — `handleToggle` builds the setEnabled body and
      // delegates to `runRowAction`, which is where the announcement lives.
      const announces = new Set(
        names.filter((n) => bodies.get(n)!.includes('announceHarnessChanged()'))
      );
      const covered = new Set([
        ...announces,
        ...names.filter((n) => [...announces].some((a) => bodies.get(n)!.includes(`${a}(`))),
      ]);

      const actions = new Set(
        [...src.matchAll(/action:\s*'([a-zA-Z]+)'/g)]
          .map((m) => m[1]!)
          .filter((a) => !NON_MUTATING.has(a))
      );

      for (const action of actions) {
        const sentFromCovered = [...covered].some((n) =>
          bodies.get(n)!.includes(`action: '${action}'`)
        );
        expect(
          sentFromCovered,
          `${file}: action '${action}' is sent without announcing the change`
        ).toBe(true);
      }
    }
  });
});
