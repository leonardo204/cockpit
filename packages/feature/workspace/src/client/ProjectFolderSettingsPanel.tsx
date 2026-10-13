'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  PROJECT_FOLDER_DEFAULT_KEY,
  PROJECT_FOLDER_FAVORITES_KEY,
  PROJECT_FOLDER_FAVORITES_MAX,
  normalizeFavorites,
  tildePath,
} from '@cockpit/shared-utils';
import {
  loadProjectFolderChoices,
  loadSettings,
  pickFolder,
  saveProjectFolderDefault,
  updateProjectFolderFavorite,
} from './effect/workspaceClient';

/**
 * THE DEFAULT PROJECT FOLDER AND THE FAVORITES — where "Open / Create project"
 * starts, in the General tab.
 *
 * VOC: the chooser always opened at the home directory. Unset, it now opens
 * beside the last folder the user picked (`src/lib/projectFolderStart.ts`); the
 * default is the "let me set it" half. The favorites are the folders the quick
 * menu offers before the chooser opens (ProjectFolderMenu.tsx). Flat like every
 * panel in this pane (`settingsLayout.test.ts`): readouts, a plain list, buttons.
 *
 * The default is shown as stored; the start resolver ignores a folder that has
 * gone and falls back on its own, so a stale value costs nothing but a re-pick.
 * A favorite that has gone is KEPT (it may be on an unplugged drive) and shown
 * with a muted "missing" note — the menu hides it, and this is the one place
 * the user can see why and remove it.
 */
export function ProjectFolderSettingsPanel() {
  const [value, setValue] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  // Favorites the server confirmed exist. Anything stored but not in here is
  // "missing". Starts null so nothing is called missing before the answer.
  const [existing, setExisting] = useState<Set<string> | null>(null);
  const [home, setHome] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    let cancelled = false;
    void BrowserRuntime.runPromiseExit(loadSettings()).then((exit) => {
      if (cancelled || exit._tag !== 'Success') return;
      const stored = exit.value[PROJECT_FOLDER_DEFAULT_KEY];
      setValue(typeof stored === 'string' && stored ? stored : null);
      setFavorites(normalizeFavorites(exit.value[PROJECT_FOLDER_FAVORITES_KEY]));
    });
    void BrowserRuntime.runPromiseExit(loadProjectFolderChoices()).then((exit) => {
      if (cancelled || exit._tag !== 'Success') return;
      setExisting(new Set(exit.value.favorites));
      setHome(exit.value.home);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (next: string | null) => {
      const exit = await BrowserRuntime.runPromiseExit(saveProjectFolderDefault(next));
      if (exit._tag === 'Success') setValue(next);
      else toast(t('projectFolder.saveFailed'), 'error');
    },
    [t],
  );

  // The same chooser "Open project" uses, so it opens where that one would.
  // `remember: false`: choosing a default is not opening a project, so it must
  // not move the last-folder memory.
  const handleChoose = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const exit = await BrowserRuntime.runPromiseExit(
      pickFolder(t('projectFolder.prompt'), { remember: false }),
    );
    if (exit._tag === 'Success' && exit.value.folder) await save(exit.value.folder);
    setBusy(false);
  }, [busy, save, t]);

  const handleClear = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    await save(null);
    setBusy(false);
  }, [busy, save]);

  const updateFavorite = useCallback(
    async (op: 'add' | 'remove', folder: string) => {
      const exit = await BrowserRuntime.runPromiseExit(updateProjectFolderFavorite(op, folder));
      if (exit._tag !== 'Success' || !exit.value.ok) {
        toast(t('projectFolder.favoriteFailed'), 'error');
        return;
      }
      setFavorites(exit.value.favorites);
      // A folder just picked exists by construction; say so without a refetch.
      if (op === 'add') setExisting((prev) => new Set([...(prev ?? []), folder]));
    },
    [t],
  );

  const handleAddFavorite = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const exit = await BrowserRuntime.runPromiseExit(
      pickFolder(t('projectFolder.favoritePrompt'), { remember: false }),
    );
    if (exit._tag === 'Success' && exit.value.folder) await updateFavorite('add', exit.value.folder);
    setBusy(false);
  }, [busy, t, updateFavorite]);

  const handleRemoveFavorite = useCallback(
    async (folder: string) => {
      if (busy) return;
      setBusy(true);
      await updateFavorite('remove', folder);
      setBusy(false);
    },
    [busy, updateFavorite],
  );

  return (
    <ProjectFolderSettingsView
      value={value}
      busy={busy}
      home={home}
      favorites={favorites.map((path) => ({
        path,
        missing: existing !== null && !existing.has(path),
      }))}
      onChoose={handleChoose}
      onClear={handleClear}
      onAddFavorite={handleAddFavorite}
      onRemoveFavorite={handleRemoveFavorite}
    />
  );
}

/** The markup alone, so it renders without the settings round-trip (tests). */
export function ProjectFolderSettingsView({
  value,
  busy,
  home,
  favorites = [],
  onChoose,
  onClear,
  onAddFavorite = () => {},
  onRemoveFavorite = () => {},
}: {
  value: string | null;
  busy: boolean;
  home?: string;
  favorites?: Array<{ path: string; missing: boolean }>;
  onChoose: () => void;
  onClear: () => void;
  onAddFavorite?: () => void;
  onRemoveFavorite?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const buttonClass =
    'text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:pointer-events-none';
  const full = favorites.length >= PROJECT_FOLDER_FAVORITES_MAX;

  return (
    <div className="space-y-3" data-testid="project-folder-settings">
      <p className="text-xs text-muted-foreground">{t('projectFolder.description')}</p>

      {value ? (
        <p
          data-testid="project-folder-value"
          className="text-xs font-mono text-foreground break-all"
          title={value}
        >
          {tildePath(value, home)}
        </p>
      ) : (
        <p data-testid="project-folder-unset" className="text-xs text-muted-foreground italic">
          {t('projectFolder.notSet')}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          data-testid="project-folder-choose"
          onClick={onChoose}
          disabled={busy}
          className={buttonClass}
        >
          {t('projectFolder.choose')}
        </button>
        <button
          type="button"
          data-testid="project-folder-clear"
          onClick={onClear}
          // Nothing to clear is a no-op, so it says so rather than inviting one.
          disabled={busy || !value}
          className={buttonClass}
        >
          {t('projectFolder.clear')}
        </button>
      </div>

      {/* FAVORITES — a heading under a rule, not a box (settingsLayout rule 3). */}
      <div className="space-y-2 pt-3 border-t border-border" data-testid="project-folder-favorites">
        <div>
          <p className="text-xs font-medium text-foreground">{t('projectFolder.favoritesTitle')}</p>
          <p className="text-xs text-muted-foreground">
            {t('projectFolder.favoritesDescription', { max: PROJECT_FOLDER_FAVORITES_MAX })}
          </p>
        </div>

        {favorites.length === 0 ? (
          <p data-testid="project-folder-favorites-empty" className="text-xs text-muted-foreground italic">
            {t('projectFolder.favoritesEmpty')}
          </p>
        ) : (
          <ul className="space-y-1">
            {favorites.map((fav) => (
              <li
                key={fav.path}
                data-testid="project-folder-favorite"
                data-missing={fav.missing ? 'true' : undefined}
                className="flex items-center gap-2"
              >
                <span
                  className={`text-xs font-mono break-all ${
                    fav.missing ? 'text-muted-foreground line-through' : 'text-foreground'
                  }`}
                  title={fav.path}
                >
                  {tildePath(fav.path, home)}
                </span>
                {fav.missing ? (
                  <span
                    data-testid="project-folder-favorite-missing"
                    className="text-xs text-muted-foreground italic flex-shrink-0"
                  >
                    {t('projectFolder.favoriteMissing')}
                  </span>
                ) : null}
                <button
                  type="button"
                  data-testid="project-folder-favorite-remove"
                  onClick={() => onRemoveFavorite(fav.path)}
                  disabled={busy}
                  aria-label={t('projectFolder.removeFavoriteLabel', { path: fav.path })}
                  className={`${buttonClass} ml-auto flex-shrink-0`}
                >
                  {t('projectFolder.removeFavorite')}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="project-folder-favorite-add"
            onClick={onAddFavorite}
            disabled={busy || full}
            className={buttonClass}
          >
            {t('projectFolder.addFavorite')}
          </button>
          {full ? (
            <span className="text-xs text-muted-foreground">
              {t('projectFolder.favoritesFull', { max: PROJECT_FOLDER_FAVORITES_MAX })}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
