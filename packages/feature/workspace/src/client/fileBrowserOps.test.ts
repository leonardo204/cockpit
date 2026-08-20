import { describe, it, expect } from 'vitest';
import {
  absolutePathOf,
  childRel,
  createParentOf,
  escapeHtml,
  failureKey,
  fsChangeDirs,
  isCommittableName,
  renameSelection,
  stripTransTags,
  type MenuTarget,
} from './fileBrowserOps';

const target = (over: Partial<MenuTarget>): MenuTarget => ({
  rel: 'src/a.ts',
  parentRel: 'src',
  name: 'a.ts',
  isDir: false,
  ...over,
});

describe('createParentOf — where "New File" lands', () => {
  it('creates INSIDE a folder row', () => {
    expect(createParentOf(target({ rel: 'src/utils', parentRel: 'src', name: 'utils', isDir: true })))
      .toBe('src/utils');
  });

  it('creates BESIDE a file row, in its parent', () => {
    // "New file here" while pointing at a file means next to that file — not
    // inside it, which is not a place.
    expect(createParentOf(target({}))).toBe('src');
  });

  it('creates at the root for a top-level file and for the panel body', () => {
    expect(createParentOf(target({ rel: 'README.md', parentRel: '', name: 'README.md' }))).toBe('');
    expect(createParentOf({ rel: '', parentRel: '', name: '', isDir: true })).toBe('');
  });
});

describe('childRel', () => {
  it('does not put a leading slash on a top-level entry', () => {
    expect(childRel('', 'README.md')).toBe('README.md');
    expect(childRel('src', 'a.ts')).toBe('src/a.ts');
  });
});

describe('absolutePathOf', () => {
  it('joins the project root and the relative path', () => {
    expect(absolutePathOf('/work/proj', 'src/a.ts')).toBe('/work/proj/src/a.ts');
  });

  it('does not double the separator when cwd ends in one', () => {
    expect(absolutePathOf('/work/proj/', 'src/a.ts')).toBe('/work/proj/src/a.ts');
  });

  it('is the project root itself for the panel body', () => {
    expect(absolutePathOf('/work/proj', '')).toBe('/work/proj');
  });
});

describe('renameSelection — the extension stays out of the selection', () => {
  it('selects the basename of an ordinary file', () => {
    expect(renameSelection('component.tsx')).toEqual({ start: 0, end: 9 });
  });

  it('keeps only the LAST extension out, so `a.test.ts` edits as `a.test`', () => {
    expect(renameSelection('a.test.ts')).toEqual({ start: 0, end: 6 });
  });

  it('selects the whole name of a dotfile — there is no basename to isolate', () => {
    expect(renameSelection('.env')).toEqual({ start: 0, end: 4 });
  });

  it('selects the whole name of a folder or extension-less file', () => {
    expect(renameSelection('src')).toEqual({ start: 0, end: 3 });
  });
});

describe('isCommittableName', () => {
  it('accepts a real change', () => {
    expect(isCommittableName('a.ts', 'b.ts')).toBe(true);
  });

  it('rejects the no-ops instead of sending a pointless request', () => {
    expect(isCommittableName('a.ts', 'a.ts')).toBe(false);
    expect(isCommittableName('a.ts', '')).toBe(false);
    expect(isCommittableName('a.ts', '   ')).toBe(false);
  });

  it('rejects a name that is really a path, before the server has to', () => {
    expect(isCommittableName('a.ts', '../b.ts')).toBe(false);
    expect(isCommittableName('a.ts', 'sub/b.ts')).toBe(false);
    expect(isCommittableName('a.ts', '..')).toBe(false);
  });
});

describe('escapeHtml — the confirm dialog is innerHTML', () => {
  it('neutralises a file name that is markup', () => {
    // i18n runs with escapeValue:false and confirm() writes innerHTML, so this
    // escaping is the only thing between a hostile file name and script
    // execution in the app's own origin.
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
  });

  it('escapes the ampersand first, so entities are not double-decoded', () => {
    expect(escapeHtml('a&<b')).toBe('a&amp;&lt;b');
  });

  it('leaves an ordinary name alone', () => {
    expect(escapeHtml('보고서 초안.md')).toBe('보고서 초안.md');
  });
});

describe('stripTransTags', () => {
  it('removes the <file> markers the confirm strings carry', () => {
    expect(stripTransTags('Move <file>notes.md</file> to trash?')).toBe('Move notes.md to trash?');
  });

  it('runs after escaping, so a file actually named <file> survives', () => {
    const name = escapeHtml('<file>');
    expect(stripTransTags(`Delete <file>${name}</file>?`)).toBe('Delete &lt;file&gt;?');
  });
});

describe('failureKey', () => {
  it('explains a collision specifically', () => {
    expect(failureKey('rename', 'exists')).toBe('fileBrowser.nameTaken');
    expect(failureKey('create', 'exists')).toBe('fileBrowser.nameTaken');
  });

  it('falls back to the per-action message for everything else', () => {
    expect(failureKey('delete', 'failed')).toBe('fileBrowser.deleteError');
    expect(failureKey('duplicate', undefined)).toBe('fileBrowser.duplicateError');
  });
});

describe('fsChangeDirs', () => {
  it('reads the directories out of a change message', () => {
    expect(fsChangeDirs({ type: 'fs-change', dirs: ['src/a', ''] })).toEqual(['src/a', '']);
  });

  it('says nothing for the channel’s other messages', () => {
    // Both are legitimate traffic; neither is a refresh.
    expect(fsChangeDirs({ type: 'fs-watch-ready' })).toEqual([]);
    expect(fsChangeDirs({ type: 'fs-watch-unavailable', reason: 'unsupported' })).toEqual([]);
  });

  it('says nothing for anything malformed', () => {
    expect(fsChangeDirs(null)).toEqual([]);
    expect(fsChangeDirs(undefined)).toEqual([]);
    expect(fsChangeDirs('fs-change')).toEqual([]);
    expect(fsChangeDirs({ type: 'fs-change' })).toEqual([]);
    expect(fsChangeDirs({ type: 'fs-change', dirs: 'src' })).toEqual([]);
  });

  it('drops entries the tree could never render', () => {
    // Defence in depth — the server scopes these already, but a nonce keyed on
    // a path outside the project would just sit there forever.
    expect(
      fsChangeDirs({
        type: 'fs-change',
        dirs: ['src', '/etc', '../up', 'a\\b', 42, null, 'ok/dir'],
      }),
    ).toEqual(['src', 'ok/dir']);
  });
});
