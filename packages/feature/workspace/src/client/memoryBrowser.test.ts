import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMemoryQuery, PAGE_SIZE, type MemoryFilters } from './MemoryBrowserModal';

/**
 * P3-M10 (specs/phase-3-memory-hygiene.md §4) — the memory browser and the
 * summary card that replaced the inline list.
 *
 * TWO KINDS OF ASSERTION, for two kinds of fact:
 *
 *   * `buildMemoryQuery` is PURE and exported precisely so the chip → query
 *     parameter mapping can be driven directly. This is the part that breaks
 *     silently: a filter that stops being sent looks exactly like a filter that
 *     matched everything, and no rendering test would notice.
 *   * Everything else here is a SOURCE assertion, the same technique as
 *     settingsLayout.test.ts and sidebarPopoverClipping.test.ts — z-index
 *     stacking, "the card does not render the whole list", "the filters are not
 *     applied client-side". jsdom has no layout and no server, so a mounted test
 *     would happily "see" a modal the browser draws underneath Settings and a
 *     filter that never left the machine.
 */

const DIR = __dirname;

/** A source file with comments stripped, so a paragraph EXPLAINING a class name
 *  (or an antipattern that was removed) is never read as the code doing it. */
const read = (f: string) =>
  readFileSync(join(DIR, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const BROWSER = read('MemoryBrowserModal.tsx');
const CARD = read('NabyMemoryReview.tsx');
const MODAL = read('SettingsModal.tsx');
const TAB_MENU = read('TabContextMenu.tsx');
const TAB_BAR = read('TabBar.tsx');
const TAB_MANAGER = read('TabManager.tsx');

const base: MemoryFilters = {
  scope: 'user',
  status: 'all',
  type: 'all',
  stale: false,
  search: '',
};
const params = (over: Partial<MemoryFilters> = {}, offset = 0) =>
  new URLSearchParams(buildMemoryQuery({ ...base, ...over }, { limit: PAGE_SIZE, offset }));

describe('buildMemoryQuery — every chip becomes a server-side parameter', () => {
  it('sends only scope and the page window when nothing is filtered', () => {
    // 'all' is the ABSENCE of a filter, not a value: sending `status=all` would
    // make the server reject it as an unknown status.
    const q = params();
    expect(q.get('scope')).toBe('user');
    expect(q.get('limit')).toBe(String(PAGE_SIZE));
    expect(q.get('offset')).toBe('0');
    expect(q.has('status')).toBe(false);
    expect(q.has('type')).toBe(false);
    expect(q.has('stale')).toBe(false);
    expect(q.has('search')).toBe(false);
  });

  it('sends each filter when it is set', () => {
    const q = params({ status: 'proposed', type: 'procedural', stale: true, search: 'postgres' });
    expect(q.get('status')).toBe('proposed');
    expect(q.get('type')).toBe('procedural');
    expect(q.get('stale')).toBe('1');
    expect(q.get('search')).toBe('postgres');
  });

  it('trims a search term and drops a blank one', () => {
    expect(params({ search: '  postgres  ' }).get('search')).toBe('postgres');
    expect(params({ search: '   ' }).has('search')).toBe(false);
  });

  it('carries the scopeKey only when the caller has one', () => {
    // `user` scope is answered by a server-side constant, so the client has no
    // key to send — and inventing one would address the wrong scope.
    expect(params().has('scopeKey')).toBe(false);
    const withKey = new URLSearchParams(
      buildMemoryQuery(base, { limit: PAGE_SIZE, offset: 0 }, '/tmp/project'),
    );
    expect(withKey.get('scopeKey')).toBe('/tmp/project');
  });

  it('advances the offset by whole pages', () => {
    expect(params({}, PAGE_SIZE).get('offset')).toBe(String(PAGE_SIZE));
  });

  it('escapes a search term rather than splicing it into the URL', () => {
    // A term with an `&` in it would otherwise become a second parameter.
    const q = params({ search: 'a&stale=1&b' });
    expect(q.get('search')).toBe('a&stale=1&b');
    expect(q.has('stale')).toBe(false);
  });
});

describe('the browser stacks above Settings, not inside it', () => {
  it('sits between the settings modal and the context-menu layer', () => {
    // SettingsModal opens it, so it must cover Settings (z-50); toasts and
    // context menus (z-[200]) must still cover IT, because an action taken in
    // here raises one.
    expect(MODAL).toContain('fixed inset-0 z-50');
    expect(BROWSER).toContain('fixed inset-0 z-[100]');
  });

  it('is a full-height overlay, not a panel inside the settings scroll area', () => {
    // Rendered inside the settings content pane it would be clipped by that
    // pane's `overflow-y-auto` — the escaping-popover mistake from
    // shell/CLAUDE.md, one level up.
    expect(BROWSER).toContain('h-[85vh]');
    expect(BROWSER).toMatch(/overflow-y-auto/);
  });

  it('closes on Escape and on a backdrop click', () => {
    expect(BROWSER).toContain("e.key === 'Escape'");
    expect(BROWSER).toMatch(/absolute inset-0 bg-black\/50[^]*onClick=\{onClose\}/);
  });
});

describe('the browser filters on the SERVER, and pages', () => {
  it('never filters the fetched page in the client', () => {
    // Client-side filtering would search only the 50 rows that happened to be on
    // screen — and "stale" is derived from the store's access history, which the
    // client cannot compute at all.
    expect(BROWSER).not.toMatch(/items\.filter\(/);
    expect(BROWSER).toContain('buildMemoryQuery');
  });

  it('debounces the search rather than fetching per keystroke', () => {
    expect(BROWSER).toContain('SEARCH_DEBOUNCE_MS');
    expect(BROWSER).toMatch(/setTimeout\([^]*SEARCH_DEBOUNCE_MS/);
  });

  it('returns to the first page whenever a filter changes', () => {
    // Keeping the offset would show page 3 of a now one-page result, which
    // renders as "no matches" for a term that plainly matches.
    expect(BROWSER).toMatch(/setFilter = useCallback\([^]*setOffset\(0\)/);
    expect(BROWSER).toMatch(/setSearchInput[^]*\n[^]*setOffset\(0\)/);
  });

  it('reports the range from the SERVER total, not from the rows in hand', () => {
    expect(BROWSER).toContain('page?.total ?? 0');
    expect(BROWSER).toContain("t('memoryReview.pageOf'");
  });

  it('offers all four filter groups plus search', () => {
    for (const key of [
      'memoryReview.searchPlaceholder',
      'memoryReview.statusProposed',
      'memoryReview.filterStale',
      'memoryReview.typeProcedural',
    ]) {
      expect(BROWSER, `${key} missing from the browser`).toContain(key);
    }
    expect(BROWSER).toContain('<ScopeSelector');
  });
});

describe('the browser carries the sovereignty actions (§3)', () => {
  it('offers confirm, edit, keep and delete on a row', () => {
    for (const action of ['confirm', 'edit', 'keepAlive', 'delete']) {
      expect(BROWSER, `${action} action missing`).toContain(`action: '${action}'`);
    }
  });

  it('edits inline in a textarea rather than a prompt dialog', () => {
    expect(BROWSER).toContain('<textarea');
  });

  it('states what an edit DOES, where the edit button is', () => {
    // "This is now attributed to you and its evidence was reset" is not
    // something a user can infer from a text box.
    expect(BROWSER).toContain("t('memoryReview.editNote')");
  });

  it('does not offer "keep" on a proposal', () => {
    // A proposal is not in the decay queue — the answer for it is confirm or
    // delete, and a third verb would only be a way to leave it undecided.
    expect(BROWSER).toMatch(/!isProposed \? \([^]*memoryReview\.keepAlive/);
  });
});

describe('the settings card is fixed size, whatever the memory grows to', () => {
  it('reads a SUMMARY rather than the rows', () => {
    // The whole reason the browser exists: the old panel listed every memory
    // inline, so the settings pane grew as the product worked better (§1).
    expect(CARD).toContain("view: 'summary'");
    expect(CARD).toContain('recentProposed');
  });

  it('renders only the pending proposals inline, clamped', () => {
    expect(CARD).toContain('proposals.map');
    expect(CARD).toContain('line-clamp-2');
    // The confirmed rows are NOT rendered here at all.
    expect(CARD).not.toMatch(/items\.map\(/);
  });

  it('keeps confirm and delete on the card — a pending decision must not need a second click', () => {
    expect(CARD).toContain("action: 'confirm'");
    expect(CARD).toContain("action: 'delete'");
  });

  it('keeps the poisoning rollback on the card', () => {
    // What someone reaches for when memory has gone wrong. That is not the
    // moment to make them find a new screen first.
    expect(CARD).toContain("action: 'deleteBySource'");
  });

  it('opens the browser and refreshes its counts when it closes', () => {
    // The browser can confirm, edit and delete; leaving the card showing the
    // numbers from before the user's work would read as the work not landing.
    expect(CARD).toContain('<MemoryBrowserModal');
    expect(CARD).toContain("t('memoryReview.openBrowser')");
    expect(CARD).toMatch(/onClose=\{\(\) => \{[^]*void reload\(\);/);
  });

  it('carries the learning switch with the asymmetry spelled out', () => {
    // Off stops CAPTURE, not RECALL (§3) — the thing that surprises people.
    expect(CARD).toContain("t('memoryReview.learningLabel')");
    expect(CARD).toContain("t('memoryReview.learningHint')");
    expect(CARD).toContain("action: 'learning.set'");
  });

  it('stays flat and keeps the shared disclosure (the settings layout contract)', () => {
    expect(CARD).toContain('<SettingsDetails>');
    expect(CARD).not.toContain('bg-muted/40');
  });
});

describe('the temporary-session toggle lives on the tab (§3)', () => {
  it('is a context-menu item beside pin and rename', () => {
    // The same KIND of thing: a per-session property set on the tab that holds
    // it. By the time you have decided this conversation should not be learned
    // from, you are looking at its tab — not at Settings.
    // Pin reads its own two-way label the same way this one does, which is the
    // shape being matched here — all three items are siblings in one menu.
    expect(TAB_MENU).toMatch(/tabBar\.unpin' : 'tabBar\.pin'/);
    expect(TAB_MENU).toContain("t('tabBar.rename')");
    expect(TAB_MENU).toMatch(/tabBar\.noLearnOff' : 'tabBar\.noLearn'/);
    expect(TAB_MENU).toContain('onToggleNoLearn');
  });

  it('is disabled on a tab that has no session yet', () => {
    // The flag is per SESSION, and a blank tab is not one until its first turn.
    // Disabled rather than hidden, so the menu does not change shape between two
    // tabs that look identical.
    expect(TAB_MENU).toContain('disabled={!state.hasSession}');
  });

  it('the label says what the CLICK will do, from state read at open time', () => {
    expect(TAB_MANAGER).toContain('isNoLearn: isNoLearn(tab?.sessionId)');
    expect(TAB_MANAGER).toContain('hasSession: Boolean(tab?.sessionId)');
  });

  it('refuses to toggle a tab with no session, matching the disabled item', () => {
    expect(TAB_MANAGER).toMatch(/handleToggleNoLearn[^]*if \(!tab\?\.sessionId\) return;/);
  });

  it('badges the tab, as state and never as a button', () => {
    // A second clickable target in the tab corner is how the pin icon ended up
    // being read as a bell and never used.
    expect(TAB_BAR).toContain('isNoLearn?.(tab.id)');
    expect(TAB_BAR).toContain("t('tabBar.noLearnBadge')");
    expect(TAB_BAR).toMatch(/data-testid="tab-no-learn-badge"/);
    const badge = TAB_BAR.slice(TAB_BAR.indexOf('data-testid="tab-no-learn-badge"'));
    expect(badge.slice(0, 400)).not.toContain('<button');
  });

  it('loads the whole set in one request rather than one per tab', () => {
    // Tabs appear in batches (restoring pinned sessions on project open); N
    // per-tab requests would fire N times on that one event.
    const HOOK = read('useNoLearnSessions.ts');
    expect(HOOK).toContain("action: 'session.noLearn.list'");
    expect(HOOK).toContain("action: 'session.noLearn.set'");
  });

  it('reconciles the optimistic toggle against the server', () => {
    // A write that failed must put the badge back where the database says it is,
    // rather than leaving the UI claiming a privacy property nothing stored.
    const HOOK = read('useNoLearnSessions.ts');
    expect(HOOK).toMatch(/await nabyPost\(\{ action: 'session\.noLearn\.set'[^]*await refresh\(\)/);
  });

  it('a failed LIST keeps the previous answer instead of clearing every badge', () => {
    const HOOK = read('useNoLearnSessions.ts');
    expect(HOOK).toMatch(/catch \{[^]*return \{ ok: false \};/);
  });
});

describe('the new copy exists in both locales', () => {
  const dict = (locale: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(join(DIR, '../../../..', 'shared/i18n/locales', `${locale}.json`), 'utf8'),
    );

  const KEYS = [
    'memoryReview.summaryTitle',
    'memoryReview.summaryConfirmed',
    'memoryReview.summaryProposed',
    'memoryReview.summaryStale',
    'memoryReview.openBrowser',
    'memoryReview.browserTitle',
    'memoryReview.searchPlaceholder',
    'memoryReview.filterStale',
    'memoryReview.pageOf',
    'memoryReview.edit',
    'memoryReview.editNote',
    'memoryReview.keepAlive',
    'memoryReview.lastUsed',
    'memoryReview.neverUsed',
    'memoryReview.staleBadge',
    'memoryReview.learningLabel',
    'memoryReview.learningHint',
    'tabBar.noLearn',
    'tabBar.noLearnOff',
    'tabBar.noLearnBadge',
  ];

  for (const locale of ['en', 'ko']) {
    const d = dict(locale);
    for (const key of KEYS) {
      it(`${locale}: ${key}`, () => {
        const value = key
          .split('.')
          .reduce<unknown>(
            (cur, part) =>
              cur && typeof cur === 'object'
                ? (cur as Record<string, unknown>)[part]
                : undefined,
            d,
          );
        expect(typeof value, `${key} missing from ${locale}.json`).toBe('string');
        expect(String(value)).not.toBe('');
      });
    }
  }

  it('ko uses the ~한다 declarative the project writes Korean in', () => {
    // The house style (CLAUDE.md): UI prose is plain declarative, not honorific.
    const ko = dict('ko') as { memoryReview: Record<string, string> };
    expect(ko.memoryReview.learningHint).toMatch(/다\.$/);
    expect(ko.memoryReview.summaryEmpty).toMatch(/다\.$/);
  });
});
