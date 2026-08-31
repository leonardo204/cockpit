import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cmd/Ctrl+T opens a new tab.
 *
 * The mirror of `closeTabShortcut.test.ts`, and it leans on the same two halves.
 * One is in this renderer: the tab host's single stable keydown listener, which
 * lives on the project iframe's own window because iframe keydowns do not bubble
 * to the parent. The other is in the Electron main process (electron/menu.ts and
 * electron/menu-template.ts in the naby repo): the application menu binds no
 * accelerator to Cmd/Ctrl+T, which is the only reason the key event reaches the
 * DOM handler asserted here. jsdom can see neither of those, so these are source
 * guards — the same shape the close-tab, sidebar-clipping and background-job
 * contracts use.
 */

const CLIENT = __dirname;
const read = (name: string) => readFileSync(join(CLIENT, name), 'utf8');

describe('Cmd/Ctrl+T — open a new tab', () => {
  it('the tab host handles the key and opens a tab', () => {
    const src = read('TabManager.tsx');
    const branch = /if \(e\.key === 't'\) \{[\s\S]*?\}/.exec(src)?.[0];
    expect(branch, "the 't' branch was removed — Cmd/Ctrl+T would do nothing").toBeDefined();
    // Swallow the browser default, and go through the same ref indirection the
    // other shortcuts use so the single stable listener never goes stale.
    expect(branch).toContain('e.preventDefault()');
    expect(branch).toContain('handleNewTabRef.current()');
    expect(src).toContain('handleNewTabRef.current = handleNewTab');
    // And the branch sits inside the modifier-guarded listener (meta/ctrl only),
    // which is what makes Ctrl+T the Windows/Linux half at no extra cost.
    expect(src).toMatch(/if \(!\(e\.metaKey \|\| e\.ctrlKey\) \|\| e\.shiftKey \|\| e\.altKey\) return;/);
  });

  it('the + button names the shortcut, with the modifier this platform uses', () => {
    const src = read('TabBar.tsx');
    // A shortcut nobody can discover is a shortcut nobody uses. The hint hangs
    // off the button that does the same thing by mouse.
    expect(src).toMatch(/\$\{modLabel\}T/);
    expect(src).toContain('<NewTabButton onNewTab={onNewTab} modLabel={modLabel} />');
  });

  it('the modifier label is resolved after mount, not during render', () => {
    // Reading `navigator` while rendering would make the server write 'Ctrl+'
    // and a Mac client write '⌘' for the same tooltip: a hydration mismatch.
    const src = read('TabBar.tsx');
    const hook = /function useModLabel\(\)[\s\S]*?\n\}/.exec(src)?.[0];
    expect(hook, 'useModLabel was removed or renamed').toBeDefined();
    expect(hook).toContain("useState('⌘')");
    expect(hook).toContain('useEffect');
    expect(hook).toContain('navigator.userAgent');
    // The numbered-tab hints share the same label rather than hardcoding ⌘.
    expect(src).toContain('title={index < 9 ? `${modLabel}${index + 1}` : undefined}');
  });
});
