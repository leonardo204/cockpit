import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Continue in a new tab" SHOWS ITS WAIT, and it happens once.
 *
 * WHAT WENT WRONG. The menu item fired a request whose server side writes a
 * handoff summary with a MODEL CALL — seconds, not milliseconds — and then closed
 * the menu. Nothing else changed. The honest reading of that UI is "the click did
 * nothing", and the natural response is to click again, which minted a SECOND
 * session with a second summary behind it. So this is two contracts, not one:
 * the wait is visible, and a repeat is refused.
 *
 * Source assertions, in the house style (`closeTabShortcut`, `settingsLayout`):
 * the subject is a spinner, a disabled attribute and an in-flight ref, and jsdom
 * would happily "see" a spinner that never stops.
 */

const CLIENT = __dirname;
const read = (name: string) => readFileSync(join(CLIENT, name), 'utf8');

/** The handler, from its comment banner to the end of its dependency array. */
const handler = () => {
  const src = read('TabManager.tsx');
  const fn = /const handleContinueInNewTab = useCallback[\s\S]*?\n  \}, \[/.exec(src)?.[0];
  expect(fn, 'handleContinueInNewTab was reshaped — re-point this guard').toBeDefined();
  return fn as string;
};

describe('continue in a new tab — the wait is visible', () => {
  it('refuses a second click while one is in flight', () => {
    const fn = handler();
    // The REF is what enforces it: two clicks in the same tick would both read
    // the pre-update state set, so the guard cannot live in state alone.
    expect(fn).toContain('if (continuingRef.current.has(tabId)) return;');
    expect(fn).toContain('continuingRef.current.add(tabId);');
  });

  it('clears the mark on every exit, including the failures', () => {
    const fn = handler();
    // A spinner that never stops is worse than no spinner: it says the app is
    // still working on something it has already given up on.
    const finallyBlock = /\} finally \{[\s\S]*?\n    \}/.exec(fn)?.[0];
    expect(finallyBlock, 'the finally block went away — a failed continue would spin forever').toBeDefined();
    expect(finallyBlock).toContain('continuingRef.current.delete(tabId);');
    expect(finallyBlock).toContain('publishContinuing();');
  });

  it('says so out loud when the continue fails', () => {
    const fn = handler();
    // Both failure paths — a refused reply and a thrown request — reach the user.
    expect(fn.match(/tabBar\.continueFailed/g)?.length).toBe(2);
  });

  it('the tab carries a spinner while the handoff is written', () => {
    const src = read('TabBar.tsx');
    expect(src).toContain('isContinuing?: (tabId: string) => boolean;');
    expect(src).toContain('data-testid="tab-continuing"');
    expect(src).toContain('animate-spin');
    // The tooltip says WHAT is happening; the spinner only says that something is.
    expect(src).toContain(
      'content={isContinuing?.(tab.id) ? `${tab.title} — ${continuingLabel}` : tab.title}',
    );
  });

  it('the menu item disables itself LIVE, not at open time', () => {
    // The other menu flags are captured when the menu opens, which is right for
    // them: their labels state what the click will do. This one describes a
    // request that can start and finish while the menu is on screen.
    const host = read('TabManager.tsx');
    expect(host).toContain('state={{ ...menu, isContinuing: continuingTabs.has(menu.tabId) }}');
    const menu = read('TabContextMenu.tsx');
    expect(menu).toContain('disabled={!state.hasSession || state.isContinuing === true}');
    expect(menu).toContain("t('tabBar.continuing'");
  });

  it('both locales carry the new strings', () => {
    const locales = join(CLIENT, '../../../../shared/i18n/locales');
    for (const file of ['en.json', 'ko.json']) {
      const tabBar = JSON.parse(readFileSync(join(locales, file), 'utf8')).tabBar as
        | Record<string, string>
        | undefined;
      expect(tabBar?.continuing, `${file} is missing tabBar.continuing`).toBeTruthy();
      expect(tabBar?.continueFailed, `${file} is missing tabBar.continueFailed`).toBeTruthy();
    }
  });
});
