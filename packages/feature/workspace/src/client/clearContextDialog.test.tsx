import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { ClearContextDialog } from './ClearContextDialog';

/**
 * session-context-management §2.2c — "Clear context" ASKS FIRST.
 *
 * The rendered half checks the dialog itself (three choices, summary is the
 * primary). The source half checks the wiring the way the house style does
 * (`continueInNewTabPending`): the menu opens the dialog instead of clearing, and
 * "keep a summary" is the continue request landing in place rather than a copy.
 */

const CLIENT = __dirname;
const read = (name: string) => readFileSync(join(CLIENT, name), 'utf8');
const render = (node: ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const noop = () => {};

describe('clear context dialog — rendered', () => {
  const html = render(<ClearContextDialog onKeepSummary={noop} onClearAll={noop} onCancel={noop} />);

  it('is a modal dialog in a fixed layer with a backdrop', () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-testid="clear-context-backdrop"');
    expect(html).toMatch(/data-testid="clear-context-dialog"/);
    expect(html).toMatch(/class="fixed inset-0/);
  });

  it('offers exactly the three choices', () => {
    expect(html).toContain('data-testid="clear-context-keep-summary"');
    expect(html).toContain('data-testid="clear-context-all"');
    expect(html).toContain('data-testid="clear-context-cancel"');
  });

  it('the summary choice is the primary one', () => {
    const keep = /<button[^>]*data-testid="clear-context-keep-summary"[^>]*>/.exec(html)?.[0] ?? '';
    expect(keep).toContain('bg-primary');
  });
});

describe('clear context dialog — behaviour (source)', () => {
  const src = read('ClearContextDialog.tsx');

  it('focuses the primary button on open', () => {
    expect(src).toContain('ref={primaryRef}');
    expect(src).toContain('primaryRef.current?.focus();');
  });

  it('Esc and the backdrop both cancel', () => {
    expect(src).toMatch(/if \(e\.key === 'Escape'\) onCancel\(\);/);
    expect(src).toMatch(/bg-black\/50" onClick=\{onCancel\}/);
  });
});

describe('clear context wiring — TabManager', () => {
  const host = read('TabManager.tsx');

  it('the menu item opens the choice instead of clearing on the click', () => {
    expect(host).toContain('onClearContext={setClearChoiceTabId}');
    expect(host).not.toContain('onClearContext={clearTab}');
    expect(host).toMatch(/\{clearChoiceTabId && \(\s*<ClearContextDialog/);
  });

  it('"clear everything" is the old /clear', () => {
    const fn = /const handleClearAll = useCallback[\s\S]*?\n  \}, \[/.exec(host)?.[0] ?? '';
    expect(fn).toContain('if (tabId) clearTab(tabId);');
  });

  it('"keep a summary" is the continue request, landing in place', () => {
    const fn = /const handleClearKeepSummary = useCallback[\s\S]*?\n  \}, \[/.exec(host)?.[0] ?? '';
    expect(fn).toContain("handleContinueInNewTab(tabId, 'in-place')");
  });

  it('in place, the seat takes the minted session — unless it belongs to another project', () => {
    const fn = /const handleContinueInNewTab = useCallback[\s\S]*?\n  \}, \[/.exec(host)?.[0] ?? '';
    expect(fn).toContain("action: 'session.continueInNewTab'");
    expect(fn).toMatch(/where === 'in-place' && \(!json\.cwd \|\| json\.cwd === tab\.cwd\)/);
    expect(fn).toContain('if (clearTab(tabId, { sessionId: json.sessionId, title })) return;');
    // The fallback when the seat cannot take it: open it, never drop it.
    expect(fn).toContain('publishTopic(Topics.OpenProject, { cwd: openIn, sessionId: json.sessionId });');
  });
});

describe('clear context dialog — locales', () => {
  it('both locales carry the dialog strings', () => {
    const locales = join(CLIENT, '../../../../shared/i18n/locales');
    for (const file of ['en.json', 'ko.json']) {
      const tabBar = JSON.parse(readFileSync(join(locales, file), 'utf8')).tabBar as Record<string, string>;
      for (const key of [
        'clearDialogTitle',
        'clearDialogBody',
        'clearKeepSummary',
        'clearAll',
        'clearCancel',
        'clearSummaryFailed',
      ]) {
        expect(tabBar[key], `${file} is missing tabBar.${key}`).toBeTruthy();
      }
    }
  });
});
