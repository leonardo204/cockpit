import { describe, it, expect } from 'vitest';
import { ABSOLUTE_PATH_RULE, shellSystemNote } from './shellNote';

/**
 * NABY WRITES PATHS IN FULL, SO THE CHAT CAN LINK THEM.
 *
 * The client deliberately refuses to expand `~` (filePathLinks.ts): guessing a
 * home directory is how a link ends up pointing somewhere its own text does not
 * say, and that property is what makes clicking a path safe at all. So the
 * contraction is prevented at the source instead.
 */

describe('the working-directory note', () => {
  it('still says where the turn is running', () => {
    expect(shellSystemNote('/Volumes/work/naby')).toContain(
      'Working directory: /Volumes/work/naby',
    );
    expect(shellSystemNote('/Volumes/work/naby')).toContain('inside the naby shell');
  });

  it('drops the directory line when there is no project', () => {
    // A chat with no project open still reports paths — from a download, from a
    // tool that wrote somewhere absolute — so the note is not skipped entirely.
    const note = shellSystemNote();
    expect(note).not.toContain('Working directory:');
    expect(note).toContain('inside the naby shell');
  });
});

describe('the path convention', () => {
  it('is present with or without a working directory', () => {
    // It used to be that no cwd meant no note at all. A path can be reported
    // from anywhere, so the convention cannot be conditional on a project.
    expect(shellSystemNote('/tmp')).toContain(ABSOLUTE_PATH_RULE);
    expect(shellSystemNote()).toContain(ABSOLUTE_PATH_RULE);
  });

  it('names the tilde as the thing to avoid, and says why', () => {
    // A rule with no reason is one a model talks itself out of. The reason is
    // also the true one: the link is what breaks.
    expect(ABSOLUTE_PATH_RULE).toContain('~');
    expect(ABSOLUTE_PATH_RULE).toContain('link');
  });

  it('shows the shape it wants rather than only describing it', () => {
    expect(ABSOLUTE_PATH_RULE).toMatch(/\/Users\/\w+\/[\w/]+\.\w+/);
  });
});
