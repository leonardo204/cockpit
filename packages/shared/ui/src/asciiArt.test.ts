import { describe, it, expect } from 'vitest';
import { fenceAsciiArt } from './asciiArt';

describe('fenceAsciiArt', () => {
  it('leaves a report alone when one triangle appears in prose (field case 2026-11-13)', () => {
    const report = [
      '## 고친 것',
      '',
      '1. **서비스·배치 줄:** 그날 실패한 배치가 있으면 "모두 성공"이라고 적지 않습니다.',
      '',
      '## 남은 결정',
      '- **다음 단계 범위:** 이상탐지 목록과 "▲948%" 카드 정리 포함.',
    ].join('\n');
    expect(fenceAsciiArt(report)).toBe(report);
  });

  it('does not fence a single line with a box glyph', () => {
    const text = 'Before\n\nA ─ B is the link.\n\nAfter';
    expect(fenceAsciiArt(text)).toBe(text);
  });

  it('fences only the drawing and keeps the surrounding markdown', () => {
    const text = [
      '## Layout',
      '',
      '┌─────┐',
      '│ app │',
      '└─────┘',
      '',
      '- **bold** item',
    ].join('\n');
    expect(fenceAsciiArt(text)).toBe(
      ['## Layout', '', '```text', '┌─────┐', '│ app │', '└─────┘', '```', '', '- **bold** item'].join('\n'),
    );
  });

  it('fences a directory tree', () => {
    const text = 'Files:\n\nsrc/\n├── a.ts\n└── b.ts\n\nDone.';
    expect(fenceAsciiArt(text)).toBe('Files:\n\n```text\nsrc/\n├── a.ts\n└── b.ts\n```\n\nDone.');
  });

  it('keeps a drawing with an empty row inside as one fence', () => {
    const text = '┌───┐\n│ a │\n└─┬─┘\n\n┌─┴─┐\n│ b │\n└───┘';
    expect(fenceAsciiArt(text)).toBe('```text\n' + text + '\n```');
  });

  it('does not touch existing fences or tables', () => {
    const fenced = 'x\n\n```\n┌─┐\n└─┘\n```\n\ny';
    expect(fenceAsciiArt(fenced)).toBe(fenced);
    const table = '| a | b |\n| --- | --- |\n| ─ | │ |\n| ┌ | ┐ |';
    expect(fenceAsciiArt(table)).toBe(table);
  });

  it('still fences a pipe-framed box but not a table missing its separator', () => {
    const box = '|  box  |\n|       |\n|  end  |';
    expect(fenceAsciiArt(box)).toBe('```text\n' + box + '\n```');
    const rows = '| a | b |\n| c | d |\n| e | f |';
    expect(fenceAsciiArt(rows)).toBe(rows);
  });
});
