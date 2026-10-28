import { describe, expect, it } from 'vitest';
import i18n from './index';
import { finalSound, withJosa } from './josa';

describe('Korean particles after an interpolated name', () => {
  it('picks the particle from the last syllable', () => {
    expect(withJosa('앱스토어 심사 담당', 'iga')).toBe('앱스토어 심사 담당이');
    expect(withJosa('나비', 'iga')).toBe('나비가');
    expect(withJosa('번역가', 'eulreul')).toBe('번역가를');
    expect(withJosa('검색', 'eunneun')).toBe('검색은');
    expect(withJosa('메일', 'euro')).toBe('메일로');
    expect(withJosa('폴더', 'euro')).toBe('폴더로');
    expect(withJosa('문서함', 'euro')).toBe('문서함으로');
    expect(withJosa('a.md', 'gwawa')).toBe('a.md와');
  });

  it('reads digits and Latin names by sound', () => {
    expect(finalSound('v1.2.0')).toBe('other'); // 영
    expect(withJosa('v2', 'eulreul')).toBe('v2를');
    expect(withJosa('aside', 'iga')).toBe('aside가');
    expect(withJosa('Gmail', 'euro')).toBe('Gmail로');
    expect(withJosa('claude-code', 'iga')).toBe('claude-code가');
    expect(withJosa('report.json', 'eulreul')).toBe('report.json을');
    expect(withJosa('PR', 'iga')).toBe('PR이');
    expect(withJosa('API', 'iga')).toBe('API가');
  });

  it('is wired into the ko dictionary', async () => {
    const t = i18n.getFixedT('ko');
    expect(t('chat.thinking', { name: '앱스토어 심사 담당' })).toBe('앱스토어 심사 담당이 생각하는 중…');
    expect(t('chat.thinking', { name: '나비' })).toBe('나비가 생각하는 중…');
  });

  it('no ko string hard-codes a particle right after a placeholder', async () => {
    const ko = (await import('../locales/ko.json')).default as Record<string, unknown>;
    const bad: string[] = [];
    const walk = (o: unknown, path: string) => {
      if (typeof o === 'string') {
        if (/\{\{[a-zA-Z]+\}\}(이|가|은|는|을|를|과|와|으로|로)(?=[\s.,…!?"]|$)/u.test(o)) bad.push(path);
      } else if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
      }
    };
    walk(ko, '');
    expect(bad).toEqual([]);
  });
});
