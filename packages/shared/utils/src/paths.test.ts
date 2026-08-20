// The one project-name implementation (see paths.ts). It replaced four, so the
// cases that used to differ between them are the cases worth pinning.

import { describe, it, expect } from 'vitest';
import { projectNameFromCwd } from './paths';

describe('projectNameFromCwd', () => {
  it('is the folder name of a posix path', () => {
    expect(projectNameFromCwd('/Users/me/work/naby')).toBe('naby');
  });

  it('ignores a trailing separator', () => {
    expect(projectNameFromCwd('/Users/me/work/naby/')).toBe('naby');
    expect(projectNameFromCwd('/Users/me/work/naby///')).toBe('naby');
  });

  it('handles Windows separators', () => {
    expect(projectNameFromCwd('C:\\Users\\me\\work\\naby')).toBe('naby');
    expect(projectNameFromCwd('C:\\Users\\me\\work\\naby\\')).toBe('naby');
  });

  it('yields the empty string for no directory', () => {
    expect(projectNameFromCwd(undefined)).toBe('');
    expect(projectNameFromCwd(null)).toBe('');
    expect(projectNameFromCwd('')).toBe('');
  });

  it('yields the empty string at the filesystem root', () => {
    // A root has no folder name. Returning '/' (which one of the four
    // implementations did) would print a slash where a project should be.
    expect(projectNameFromCwd('/')).toBe('');
  });

  it('accepts a bare relative name', () => {
    expect(projectNameFromCwd('naby')).toBe('naby');
  });
});
