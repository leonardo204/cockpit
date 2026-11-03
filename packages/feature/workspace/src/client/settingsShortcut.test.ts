import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cmd+, (macOS) / Ctrl+, (Windows/Linux) opens Settings.
 *
 * Two halves, like the new-tab and close-tab shortcuts: the accelerator lives
 * on the Electron application menu (electron/menu-template.ts in the naby
 * repo), which sends `app-menu:open-settings` through preload's
 * `appMenu.onOpenSettings`; this renderer subscribes and opens the modal. The
 * Electron side is outside this repo, so this is a source guard on the half
 * that is here.
 */

const src = readFileSync(join(__dirname, 'Workspace.tsx'), 'utf8');

describe('Cmd/Ctrl+, — open Settings', () => {
  it('subscribes to the menu bridge and opens Settings', () => {
    expect(src).toContain('.naby?.appMenu;');
    expect(src).toContain('return bridge?.onOpenSettings?.(() => openSettings());');
  });

  it('unsubscribes on unmount (the effect returns the unsubscriber)', () => {
    expect(src).toMatch(/useEffect\(\(\) => \{[\s\S]{0,300}return bridge\?\.onOpenSettings[\s\S]{0,40}\}, \[openSettings\]\);/);
  });
});
