import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The "what changed" popup's wiring, asserted at the source.
 *
 * Everything the popup DECIDES is a pure function in releaseNotesOps.ts and is
 * unit-tested there. What is left is the part no pure test can reach and jsdom
 * cannot either — it has no layout, no portal host worth the name, no preload
 * bridge and no second launch — yet each item below is a way to ship this
 * feature looking correct and being wrong:
 *
 *   1. THE OVERLAY IS CLIPPED AWAY. The workspace wraps its panels in a
 *      `translateX` container and several hosts are `overflow-hidden`, so an
 *      in-place overlay is cut off — the bug that once erased three sidebar
 *      panels (shell/CLAUDE.md).
 *   2. IT COLLIDES WITH ONBOARDING. A brand-new user getting a changelog on top
 *      of the setup wizard is the exact failure the fresh-install rule exists
 *      to prevent; the z-order and the onboarding guard are the two halves of
 *      it that only the source shows.
 *   3. IT NEVER RECORDS, so it reappears every launch. Or it records on BOTH
 *      paths, so someone who quits before reading loses the notes.
 *   4. IT IS NOT RE-OPENABLE, so a mis-click loses it for good.
 */

const DIR = __dirname;
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');
const LOCALES = join(DIR, '..', '..', '..', '..', 'shared', 'i18n', 'locales');
const dict = (locale: string): Record<string, Record<string, string>> =>
  JSON.parse(readFileSync(join(LOCALES, `${locale}.json`), 'utf8'));

const MODAL = read('WhatsNewModal.tsx');

describe('the overlay escapes the hosts that clip', () => {
  it('renders through Portal, fixed and full-viewport', () => {
    expect(MODAL).toContain("from '@cockpit/shared-ui'");
    expect(MODAL).toContain('<Portal>');
    const root = /className="fixed inset-0 z-50[^"]*"/.exec(MODAL)?.[0];
    expect(root, 'overlay root className not found — did the markup change?').toBeDefined();
    expect(root).not.toContain('absolute');
  });

  it('closes on Escape, like every other overlay here', () => {
    expect(MODAL).toContain('useEscToClose(onClose)');
  });

  it('renders the notes with the shared renderer rather than a private copy', () => {
    expect(MODAL).toContain('MarkdownRenderer');
    expect(MODAL).toContain('bodyFor(entry, i18n.language)');
  });
});

describe('it does not fight the startup flow', () => {
  const WORKSPACE = read('Workspace.tsx');
  const WIZARD = read('NabyProviderSetup.tsx');

  it('is mounted as a sibling of the workspace, not a wrapper around it', () => {
    // A wrapper could withhold the app while it waits for two IPC round trips.
    expect(WORKSPACE).toContain('<WhatsNewGate />');
    expect(WORKSPACE).not.toContain('</WhatsNewGate>');
  });

  it('draws UNDER the onboarding wizard', () => {
    // The premise is asserted too: if the wizard ever stops being z-[60] this
    // rule is guarding nothing.
    expect(WIZARD).toContain('fixed inset-0 z-[60]');
    expect(MODAL).toContain('fixed inset-0 z-50');
  });

  it('waits for onboarding to be finished before showing anything', () => {
    // The case the fresh-install rule does NOT cover: a user who skipped the
    // wizard without a key (so it is still up) and later updates.
    expect(MODAL).toContain('api.onboarding.state()');
    expect(MODAL).toContain('onboarded !== true');
  });

  it('shows nothing outside the desktop app', () => {
    expect(MODAL).toContain('if (!api?.whatsNew) return');
  });
});

describe('once per version, and it survives a restart', () => {
  it('records on DISMISSAL, which every close path reaches', () => {
    // The ✕, the button, Escape and the backdrop all call onClose, and the gate
    // passes `dismiss` as onClose — so there is one acknowledgement path, not
    // four that can drift.
    expect(MODAL).toContain('onClose={dismiss}');
    expect(MODAL).toMatch(/const dismiss = useCallback\(\(\) => \{[\s\S]*?markSeen\(version\)/);
  });

  it('records the SILENT cases too — and does not record on both paths', () => {
    expect(MODAL).toContain('markSeen(plan.recordSilently)');
    // `recordSilently` is null whenever the popup is about to be shown, so the
    // silent branch returns before the modal can be scheduled.
    expect(MODAL).toMatch(/if \(plan\.recordSilently\) \{[\s\S]*?return;\s*\}/);
  });

  it('keeps the watermark in the MAIN process, not in localStorage', () => {
    // The embedded server binds listen(0), so the renderer origin changes every
    // launch and localStorage is empty on every restart — a watermark kept
    // there would read as a fresh install forever and the popup would never
    // appear at all.
    expect(MODAL).not.toContain('localStorage');
    // The two facts arrive over the preload bridge instead.
    expect(MODAL).toContain('w.naby');
    expect(MODAL).toContain('markSeen(');
  });
});

describe('it is re-openable', () => {
  const PANEL = read('UpdatePanel.tsx');

  it('sits beside "check for updates" in Settings', () => {
    expect(PANEL).toContain("import { WhatsNewButton } from './WhatsNewModal'");
    expect(PANEL).toContain('<WhatsNewButton />');
  });

  it('shows the archive, and records nothing', () => {
    const button = MODAL.slice(MODAL.indexOf('export function WhatsNewButton'));
    expect(button).toContain('allNotesUpTo(ALL_NOTES, version)');
    expect(button).not.toContain('markSeen');
  });

  it('obeys the settings pane no-box rule', () => {
    // UpdatePanel is in settingsLayout.test.ts's PANELS list; the button added
    // to it must not reintroduce a tinted box.
    expect(PANEL).not.toContain('bg-muted/40');
  });
});

describe('the changelog is a maintained file, bundled with the app', () => {
  it('is imported as a module — no fetch, no runtime path resolution', () => {
    const notes = read('releaseNotes.ts');
    expect(notes).toContain('export const RELEASE_NOTES_MARKDOWN');
    expect(MODAL).toContain("from './releaseNotes'");
    // A network read would leave the popup showing an empty box offline, and a
    // file read would have to resolve a path inside app.asar.
    expect(MODAL).not.toContain('fetch(');
    expect(MODAL).not.toContain('readFileSync');
  });

  it('is parsed once per bundle, not once per render', () => {
    expect(MODAL).toMatch(/^const ALL_NOTES.*parseReleaseNotes\(RELEASE_NOTES_MARKDOWN\);$/m);
  });
});

describe('the copy exists in both languages', () => {
  const KEYS = ['title', 'updatedTo', 'currentVersion', 'reopen', 'dismiss', 'empty'] as const;

  for (const locale of ['en', 'ko'] as const) {
    it(`${locale}.json carries every whatsNew key`, () => {
      const section = dict(locale).whatsNew;
      expect(section, `whatsNew missing from ${locale}.json`).toBeTruthy();
      for (const key of KEYS) {
        expect(String(section?.[key] ?? ''), `whatsNew.${key} missing from ${locale}`).not.toBe('');
      }
    });
  }

  it('interpolates the version in the two version lines', () => {
    for (const locale of ['en', 'ko'] as const) {
      expect(dict(locale).whatsNew?.updatedTo).toContain('{{version}}');
      expect(dict(locale).whatsNew?.currentVersion).toContain('{{version}}');
    }
  });
});
