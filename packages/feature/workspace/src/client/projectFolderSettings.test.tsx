import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { ProjectFolderSettingsView } from './ProjectFolderSettingsPanel';

/**
 * The "default project folder" control in Settings → General.
 *
 * Rendered with `renderToStaticMarkup` (there is no DOM harness in this repo),
 * so these pin the markup for each state: a set folder shows its path and an
 * enabled Clear, an unset one shows the "starts beside the last folder" line
 * and a disabled Clear. What the buttons DO is pinned in the client tests
 * (src/folderPicker.test.ts: Clear writes `null`, Choose does not move the
 * last-folder memory) and by the source checks at the bottom.
 */

const render = (
  value: string | null,
  busy = false,
  extra: { favorites?: Array<{ path: string; missing: boolean }>; home?: string } = {},
) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ProjectFolderSettingsView
        value={value}
        busy={busy}
        onChoose={() => {}}
        onClear={() => {}}
        {...extra}
      />
    </I18nextProvider>,
  );

const count = (html: string, needle: string) => html.split(needle).length - 1;

/** The opening tag of the element carrying `data-testid`. */
const tagOf = (html: string, testid: string) =>
  new RegExp(`<[^>]*data-testid="${testid}"[^>]*>`).exec(html)?.[0] ?? '';

/** Whether that element carries the `disabled` ATTRIBUTE — not the
 *  `disabled:` Tailwind variants in its class list. */
const isDisabled = (html: string, testid: string) =>
  /\sdisabled=""/.test(tagOf(html, testid));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('ProjectFolderSettingsView', () => {
  it('shows the stored folder and lets it be cleared', () => {
    const html = render('/Users/me/work');
    expect(html).toContain('data-testid="project-folder-value"');
    expect(html).toContain('/Users/me/work');
    expect(html).not.toContain('data-testid="project-folder-unset"');
    expect(isDisabled(html, 'project-folder-clear')).toBe(false);
    expect(isDisabled(html, 'project-folder-choose')).toBe(false);
    expect(html).toContain('Choose…');
    expect(html).toContain('Clear');
  });

  it('says where it starts when nothing is set, with nothing to clear', () => {
    const html = render(null);
    expect(html).toContain('data-testid="project-folder-unset"');
    expect(html).toContain('Not set — starts next to the last folder you opened.');
    expect(html).not.toContain('data-testid="project-folder-value"');
    expect(isDisabled(html, 'project-folder-clear')).toBe(true);
    expect(isDisabled(html, 'project-folder-choose')).toBe(false);
  });

  it('locks both buttons while a pick or a save is in flight', () => {
    const html = render('/Users/me/work', true);
    expect(isDisabled(html, 'project-folder-choose')).toBe(true);
    expect(isDisabled(html, 'project-folder-clear')).toBe(true);
  });

  it('renders the Korean copy', async () => {
    await i18n.changeLanguage('ko');
    try {
      const html = render(null);
      expect(html).toContain('설정하지 않으면 마지막으로 연 폴더 옆에서 시작합니다.');
      expect(html).toContain('지우기');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('ProjectFolderSettingsView — favorites', () => {
  it('lists the favorites with a remove button each, home shown as ~', () => {
    const html = render(null, false, {
      home: '/Users/me',
      favorites: [
        { path: '/Users/me/work', missing: false },
        { path: '/srv/shared', missing: false },
      ],
    });
    expect(count(html, 'data-testid="project-folder-favorite"')).toBe(2);
    expect(count(html, 'data-testid="project-folder-favorite-remove"')).toBe(2);
    expect(html).toContain('>~/work<');
    expect(html).toContain('title="/Users/me/work"');
    expect(html).toContain('aria-label="Remove /srv/shared from favorites"');
    expect(html).not.toContain('project-folder-favorite-missing');
    expect(html.indexOf('~/work')).toBeLessThan(html.indexOf('/srv/shared'));
  });

  it('shows a stale favorite with the muted missing hint, still removable', () => {
    const html = render(null, false, {
      favorites: [{ path: '/Volumes/Unplugged/proj', missing: true }],
    });
    expect(html).toContain('data-missing="true"');
    expect(html).toContain('data-testid="project-folder-favorite-missing"');
    expect(html).toContain('Folder not found — hidden from the menu');
    expect(html).toContain('text-muted-foreground line-through');
    expect(isDisabled(html, 'project-folder-favorite-remove')).toBe(false);
  });

  it('says so when there are none, and Add is available', () => {
    const html = render(null);
    expect(html).toContain('data-testid="project-folder-favorites-empty"');
    expect(html).toContain('No favorites yet.');
    expect(isDisabled(html, 'project-folder-favorite-add')).toBe(false);
  });

  it('a full list disables Add and says why', () => {
    const favorites = Array.from({ length: 10 }, (_, i) => ({ path: `/f/${i}`, missing: false }));
    const html = render(null, false, { favorites });
    expect(isDisabled(html, 'project-folder-favorite-add')).toBe(true);
    expect(html).toContain('Up to 10 favorites.');
  });

  it('the Korean copy', async () => {
    await i18n.changeLanguage('ko');
    try {
      const html = render(null, false, { favorites: [{ path: '/x', missing: true }] });
      expect(html).toContain('즐겨찾기 폴더');
      expect(html).toContain('폴더를 찾을 수 없어 메뉴에서 숨겼습니다');
      expect(html).toContain('폴더 추가…');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('the panel wiring', () => {
  const src = readFileSync(join(__dirname, 'ProjectFolderSettingsPanel.tsx'), 'utf8');

  it('Clear stores null, Choose stores the picked folder', () => {
    expect(src).toContain('await save(null)');
    expect(src).toContain('await save(exit.value.folder)');
    expect(src).toContain('saveProjectFolderDefault(next)');
  });

  it('Add picks a folder (without touching the last-folder memory) and adds it; Remove removes', () => {
    expect(src).toMatch(/pickFolder\(t\('projectFolder\.favoritePrompt'\), \{ remember: false \}\)/);
    expect(src).toContain("updateFavorite('add', exit.value.folder)");
    expect(src).toContain("updateFavorite('remove', folder)");
    expect(src).toContain('updateProjectFolderFavorite(op, folder)');
  });

  it('a favorite is missing only once the server has answered which exist', () => {
    // `existing` starts null, so nothing is flagged during the first fetch.
    expect(src).toContain('missing: existing !== null && !existing.has(path)');
    expect(src).toContain('loadProjectFolderChoices()');
  });

  it('choosing a default does not move the last-folder memory', () => {
    expect(src).toMatch(/pickFolder\(t\('projectFolder\.prompt'\), \{ remember: false \}\)/);
  });

  it('is mounted under General', () => {
    const modal = readFileSync(join(__dirname, 'SettingsModal.tsx'), 'utf8');
    const general = modal.slice(
      modal.indexOf("section === 'general'"),
      modal.indexOf("section === 'provider'"),
    );
    expect(general).toContain('<ProjectFolderSettingsPanel />');
    expect(general).toContain("t('projectFolder.title')");
  });

  it('has its copy in both locales', () => {
    const locales = join(__dirname, '../../../../shared/i18n/locales');
    for (const locale of ['en', 'ko']) {
      const dict = JSON.parse(readFileSync(join(locales, `${locale}.json`), 'utf8'));
      for (const key of [
        'title',
        'description',
        'notSet',
        'choose',
        'clear',
        'prompt',
        'saveFailed',
        'favoritesTitle',
        'favoritesDescription',
        'favoritesEmpty',
        'addFavorite',
        'removeFavorite',
        'removeFavoriteLabel',
        'favoriteMissing',
        'favoritesFull',
        'favoritePrompt',
        'favoriteFailed',
      ]) {
        expect(typeof dict.projectFolder?.[key], `${locale}: projectFolder.${key}`).toBe('string');
      }
      for (const key of ['label', 'last', 'addFavorite', 'addFavoriteFailed', 'browse']) {
        expect(typeof dict.projectFolderMenu?.[key], `${locale}: projectFolderMenu.${key}`).toBe('string');
      }
    }
  });
});
