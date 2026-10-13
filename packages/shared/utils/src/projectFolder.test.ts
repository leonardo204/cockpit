import { describe, it, expect } from 'vitest';
import {
  PROJECT_FOLDER_FAVORITES_MAX,
  addFavorite,
  normalizeFavorites,
  removeFavorite,
  tildePath,
} from './projectFolder';

/**
 * The favorites list rules, shared by the favorites route (which writes) and
 * every reader (the start route, Settings, the quick menu). The file is
 * hand-editable, so the reader-side normalisation matters as much as the
 * writer-side add/remove.
 */

const many = (n: number) => Array.from({ length: n }, (_, i) => `/f/${i}`);

describe('normalizeFavorites', () => {
  it('keeps strings in order, drops junk and duplicates', () => {
    expect(normalizeFavorites(['/a', 3, '', null, '/b', '/a', { x: 1 }, '/c'])).toEqual([
      '/a',
      '/b',
      '/c',
    ]);
  });

  it('is empty for anything that is not an array', () => {
    for (const v of [undefined, null, '/a', 42, { 0: '/a' }]) expect(normalizeFavorites(v)).toEqual([]);
  });

  it('caps the list', () => {
    expect(normalizeFavorites(many(15))).toEqual(many(PROJECT_FOLDER_FAVORITES_MAX));
  });
});

describe('addFavorite / removeFavorite', () => {
  it('appends — insertion order', () => {
    expect(addFavorite(['/a'], '/b')).toEqual(['/a', '/b']);
    expect(addFavorite(undefined, '/a')).toEqual(['/a']);
  });

  it('a duplicate keeps its place', () => {
    expect(addFavorite(['/a', '/b'], '/a')).toEqual(['/a', '/b']);
  });

  it('a full list is left alone rather than silently evicting the oldest', () => {
    const full = many(PROJECT_FOLDER_FAVORITES_MAX);
    expect(addFavorite(full, '/new')).toEqual(full);
  });

  it('removes only the named folder', () => {
    expect(removeFavorite(['/a', '/b', '/c'], '/b')).toEqual(['/a', '/c']);
    expect(removeFavorite(['/a'], '/zzz')).toEqual(['/a']);
  });
});

describe('tildePath', () => {
  it('shows the home directory as ~', () => {
    expect(tildePath('/Users/me', '/Users/me')).toBe('~');
    expect(tildePath('/Users/me/work/acme', '/Users/me')).toBe('~/work/acme');
    expect(tildePath('/Users/me/work', '/Users/me/')).toBe('~/work');
  });

  it('does not shorten a sibling that merely starts with the same letters', () => {
    expect(tildePath('/Users/me2/work', '/Users/me')).toBe('/Users/me2/work');
  });

  it('handles a Windows home', () => {
    expect(tildePath('C:\\Users\\me\\work', 'C:\\Users\\me')).toBe('~\\work');
  });

  it('leaves the path alone with no home', () => {
    expect(tildePath('/a/b', undefined)).toBe('/a/b');
    expect(tildePath('/a/b', '')).toBe('/a/b');
  });
});
