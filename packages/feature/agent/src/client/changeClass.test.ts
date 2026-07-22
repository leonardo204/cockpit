import { describe, it, expect } from 'vitest';
import { classifyPath, classifyFiles } from './changeClass';

describe('classifyPath', () => {
  it('recognizes test files', () => {
    expect(classifyPath('src/foo.test.ts')).toBe('test');
    expect(classifyPath('packages/a/src/b.spec.tsx')).toBe('test');
    expect(classifyPath('tests/integration/run.py')).toBe('test');
    expect(classifyPath('src/__tests__/x.ts')).toBe('test');
  });

  it('recognizes docs files', () => {
    expect(classifyPath('README.md')).toBe('docs');
    expect(classifyPath('README.zh.md')).toBe('docs');
    expect(classifyPath('docs/guide/setup.rst')).toBe('docs');
    expect(classifyPath('website/content/page.mdx')).toBe('docs');
    expect(classifyPath('LICENSE')).toBe('docs');
  });

  it('treats regular code and i18n locales as critical (null)', () => {
    expect(classifyPath('src/index.ts')).toBeNull();
    expect(classifyPath('packages/shared/i18n/locales/ko.json')).toBeNull();
    // "contests/" must not match the tests/ dir rule
    expect(classifyPath('src/contests/rank.ts')).toBeNull();
    // test-ish name without the .test./.spec. convention stays code
    expect(classifyPath('src/latest.ts')).toBeNull();
  });
});

describe('classifyFiles', () => {
  it('marks a set only when every file agrees', () => {
    expect(classifyFiles(['a/b.test.ts', 'tests/c.ts'])).toBe('test');
    expect(classifyFiles(['README.md', 'docs/x.md'])).toBe('docs');
    expect(classifyFiles(['a/b.test.ts', 'src/impl.ts'])).toBeNull(); // mixed
    expect(classifyFiles(['README.md', 'a/b.test.ts'])).toBeNull(); // docs+test mixed
    expect(classifyFiles([])).toBeNull();
  });
});
