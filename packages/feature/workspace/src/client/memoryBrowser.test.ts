import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildMemoryQuery,
  PAGE_SIZE,
  STYLE_KEY_PREFIX,
  type MemoryFilters,
} from './MemoryBrowserModal';
import { reflectionAgeCopy } from './NabyMemoryReview';

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
  superseded: false,
  keyPrefix: '',
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
    expect(BROWSER).toMatch(/!isProposed && !isSuperseded \? \([^]*memoryReview\.keepAlive/);
  });
});

describe('supersession is visible and reversible (P3-M13a §3.1)', () => {
  it('sends the replaced filter as a server-side parameter', () => {
    expect(params({ superseded: true }).get('superseded')).toBe('1');
    // OFF means "no filter", not "current only": a replaced memory is still the
    // user's, so it stays in the ordinary list rather than being hidden until a
    // chip is found.
    expect(params().has('superseded')).toBe(false);
  });

  it('badges a replaced row and names what replaced it', () => {
    expect(BROWSER).toContain("t('memoryReview.supersededBadge')");
    expect(BROWSER).toContain("t('memoryReview.supersededBy'");
    // A replacement the user has since deleted still has to read as something.
    expect(BROWSER).toContain("t('memoryReview.supersededByGone')");
  });

  it('offers the undo, because supersession is automatic', () => {
    expect(BROWSER).toContain("action: 'revertSupersession'");
    expect(BROWSER).toContain("t('memoryReview.revert')");
  });

  it('hides confirm and keep on a replaced row', () => {
    // Both would appear to do nothing: a replaced row is not injected, so
    // confirming it or marking it fresh changes nothing the user can see.
    expect(BROWSER).toMatch(/isProposed && !isSuperseded \? \([^]*memoryReview\.confirm/);
  });
});

/**
 * IA-3 — THE KEY-NAMESPACE FILTER (settings-ia-reorg §3.4).
 *
 * The style group on the memory tab deep links into the browser narrowed to
 * `style/*`. That narrowing is a SERVER-SIDE parameter for the same two reasons
 * every other chip is (the page is 50 rows of possibly thousands; the total
 * beside it must describe the same set), and it is deliberately not the search
 * box — see `MemoryFilters.keyPrefix`.
 */
describe('the browser can be narrowed to a key namespace', () => {
  it('sends the prefix as its own parameter, not as a search term', () => {
    const q = params({ keyPrefix: STYLE_KEY_PREFIX });
    expect(q.get('keyPrefix')).toBe('style/');
    // If this were folded into `search` it would also match a memory whose TEXT
    // mentions style/, which is not a style preference.
    expect(q.has('search')).toBe(false);
  });

  it('omits it when there is none, and trims a padded one', () => {
    expect(params().has('keyPrefix')).toBe(false);
    expect(params({ keyPrefix: '  style/  ' }).get('keyPrefix')).toBe('style/');
    expect(params({ keyPrefix: '   ' }).has('keyPrefix')).toBe(false);
  });

  it('combines with the other chips rather than replacing them', () => {
    const q = params({ keyPrefix: STYLE_KEY_PREFIX, status: 'confirmed' });
    expect(q.get('keyPrefix')).toBe('style/');
    expect(q.get('status')).toBe('confirmed');
  });

  it('offers a chip so an arriving deep link can be widened again', () => {
    // A view the user cannot get out of is a dead end, which is the one thing a
    // browser must not be.
    expect(BROWSER).toContain('data-testid="memory-style-chip"');
    expect(BROWSER).toContain("t('memoryReview.filterStyle')");
    expect(BROWSER).toMatch(/keyPrefix: filters\.keyPrefix === STYLE_KEY_PREFIX \? '' : STYLE_KEY_PREFIX/);
  });

  it('applies a deep link on OPEN, and only when there is one', () => {
    // Applied once at mount it would never arrive (the browser is mounted,
    // closed, for the life of the card that owns it); applied unconditionally on
    // every open it would throw away the chips the user set last time.
    expect(BROWSER).toMatch(/if \(!isOpen \|\| !seed \|\| Object\.keys\(seed\)\.length === 0\) return;/);
    expect(CARD).toContain("setBrowserOpen('style')");
    expect(CARD).toMatch(/keyPrefix: STYLE_KEY_PREFIX/);
    expect(CARD).toContain("t('memoryReview.openStyleBrowser')");
  });
});

/**
 * IA-3 — THE DECISIONS INBOX (settings-ia-reorg §3.3).
 *
 * The tab's first block, and the only one that is waiting for the user. Three
 * groups, each rendered only when it has something in it, and the whole block
 * absent when none of them do.
 */
describe('the memory tab opens with what needs deciding', () => {
  it('renders three groups, each only when non-empty', () => {
    expect(CARD).toContain('data-testid="memory-inbox"');
    expect(CARD).toMatch(/hasInbox =\s*proposals\.length > 0 \|\| styleProposals\.length > 0 \|\| supersessions\.length > 0/);
    expect(CARD).toMatch(/\{hasInbox \? \(/);
    expect(CARD).toMatch(/\{proposals\.length > 0 \? \(/);
    // Each group says which KIND of decision it holds.
    for (const key of [
      'memoryReview.inboxMemory',
      'memoryReview.inboxStyle',
      'memoryReview.inboxSuperseded',
    ]) {
      expect(CARD, `${key} missing from the inbox`).toContain(key);
    }
    expect(CARD).toMatch(/\{styleProposals\.length > 0 \? \(/);
    expect(CARD).toMatch(/\{supersessions\.length > 0 \? \(/);
  });

  it('badges the style proposals a person MUST approve, and only those', () => {
    // `style/global/*` is the one class corroboration may never confirm (P3-M13c
    // §3.3), so the badge carries a fact about what has to happen next — which
    // is the only reason this pane allows a badge at all.
    expect(CARD).toContain('manualOnly={isGlobal}');
    expect(CARD).toContain("t('memoryReview.manualApproval')");
    expect(CARD).toContain('data-testid="memory-manual-approval"');
    // The flag comes from the SERVER, not from a second spelling of the rule.
    expect(CARD).toContain('pendingStyleProposals');
  });

  it('states a replacement in both claims, with the undo on it', () => {
    // Supersession is the one thing here a machine does to a user's own words
    // without being asked; a reversible act nobody is told about is an
    // irreversible one in practice.
    expect(CARD).toContain('data-testid="memory-supersession"');
    expect(CARD).toContain("t('memoryReview.supersessionLine'");
    expect(CARD).toContain("t('memoryReview.supersessionOld'");
    expect(CARD).toContain("t('memoryReview.supersessionNew'");
    // A replacement the user has since deleted still has to read as something.
    expect(CARD).toContain("t('memoryReview.supersededByGone')");
    expect(CARD).toContain("action: 'revertSupersession'");
    expect(CARD).toContain('data-testid="memory-supersession-revert"');
  });

  it('hands the badge count back rather than being polled for it', () => {
    expect(CARD).toContain('notifyPending.current?.(res.data.pendingCount ?? 0)');
    // Held in a ref: an inline callback from SettingsModal as a dependency of
    // `reload` would refetch on every parent render.
    expect(CARD).toMatch(/const notifyPending = useRef\(onPendingChange\)/);
  });

  it('names the four learning channels, one line each', () => {
    // The group's whole job: two switches do not answer "so what gets
    // remembered, and when am I asked?".
    expect(CARD).toContain('data-testid="memory-channels"');
    for (const key of [
      'memoryReview.channelProposal',
      'memoryReview.channelCorroboration',
      'memoryReview.channelReflection',
      'memoryReview.channelStyle',
    ]) {
      expect(CARD, `${key} missing from the learning-method group`).toContain(key);
    }
    // Both switches in ONE group, which is the point of the regroup.
    expect(CARD).toContain('data-testid="memory-learning-method"');
    expect(CARD).toContain("t('memoryReview.learningMethodTitle')");
  });

  it('keeps the browser button visible and puts the rollback one tap away', () => {
    // The bulk delete answers "something has gone wrong"; standing open at the
    // foot of the tab it competed with the decisions that DO need answering.
    expect(CARD).toContain('data-testid="memory-open-browser"');
    const details = CARD.slice(CARD.indexOf('<SettingsDetails>'));
    expect(details).toContain("t('memoryReview.bulkTitle')");
    expect(details).toContain("action: 'deleteBySource'");
  });
});

describe('reflectionAgeCopy — "when did it last look back"', () => {
  const HOUR = 3_600_000;

  it('says "not yet" when it never has', () => {
    expect(reflectionAgeCopy(undefined, 1_000).key).toBe('memoryReview.reflectionNever');
  });

  it('does not say "0 hours ago"', () => {
    // Which reads as broken. Under an hour is its own sentence.
    expect(reflectionAgeCopy(1_000_000 - 40 * 60_000, 1_000_000)).toEqual({
      key: 'memoryReview.reflectionRecent',
      count: 0,
    });
  });

  it('counts hours below a day and days above it', () => {
    const now = 100 * HOUR;
    expect(reflectionAgeCopy(now - 5 * HOUR, now)).toEqual({
      key: 'memoryReview.reflectionHoursAgo',
      count: 5,
    });
    expect(reflectionAgeCopy(now - 23 * HOUR, now).key).toBe('memoryReview.reflectionHoursAgo');
    expect(reflectionAgeCopy(now - 24 * HOUR, now)).toEqual({
      key: 'memoryReview.reflectionDaysAgo',
      count: 1,
    });
    expect(reflectionAgeCopy(now - 72 * HOUR, now).count).toBe(3);
  });

  it('never reports a negative age', () => {
    // A clock that moved backwards (or a stamp from a machine ahead of this one)
    // must not render "last looked back -3 hours ago".
    expect(reflectionAgeCopy(2_000, 1_000).key).toBe('memoryReview.reflectionRecent');
  });
});

describe('the style fingerprint is shown, read-only (P3-M13c §3.3)', () => {
  it('lives on the settings card next to the memory review', () => {
    expect(CARD).toContain("t('memoryReview.styleTitle')");
    expect(CARD).toContain("action: 'style.get'");
  });

  it('says so before it has enough evidence, rather than showing a profile', () => {
    expect(CARD).toContain("t('memoryReview.styleEmpty')");
    expect(CARD).toContain("t('memoryReview.styleLearning'");
    expect(CARD).toContain('styleMinSamples');
  });

  it('offers no control over it', () => {
    // §3.3 and §4: there is no style toggle. The learning switch and the
    // temporary-session flag already answer "should naby learn this", and a
    // third switch for one half of it would be a setting nobody can reason about.
    // The section runs from its heading to its own closing note, so the slice
    // cannot accidentally swallow the next section's checkbox.
    const from = CARD.indexOf("memoryReview.styleTitle");
    const to = CARD.indexOf("memoryReview.styleHint");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const section = CARD.slice(from, to);
    expect(section).not.toContain('<input');
    expect(section).not.toContain('onChange');
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
    // settings-ia-reorg §3.3/§3.4 — the inbox, the badge and the deep link.
    'memoryReview.inboxMemory',
    'memoryReview.inboxStyle',
    'memoryReview.inboxSuperseded',
    'memoryReview.manualApproval',
    'memoryReview.manualApprovalTitle',
    'memoryReview.supersessionLine',
    'memoryReview.supersessionOld',
    'memoryReview.supersessionNew',
    // The inbox heading that states how many decisions are waiting. It used to
    // be the second of two places the number was spoken (the nav badge was the
    // first); the badge is gone, so this is the only one.
    'memoryReview.summaryPendingCount',
    'memoryReview.learningMethodTitle',
    'memoryReview.reflectionNever',
    'memoryReview.reflectionRecent',
    'memoryReview.reflectionHoursAgo',
    'memoryReview.reflectionDaysAgo',
    'memoryReview.openStyleBrowser',
    'memoryReview.filterStyle',
    'memoryReview.filterStyleTitle',
    'settings.general',
    'settings.connections',
    'settings.mcpServers',
    'growth.report.title',
    'growth.report.open',
    'growth.report.close',
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

  /**
   * KOREAN UI COPY IS POLITE ~합니다체, AND THE WHOLE TAB HAS TO AGREE.
   *
   * THIS ASSERTION USED TO SAY THE OPPOSITE, and it was reading the wrong rule.
   * CLAUDE.md's "~한다 평서형" applies to the SPEC TREES (`specs/`,
   * `ref-docs/specs/`) — documents naby's authors read. It was applied to UI
   * strings as well, so the memory tab drifted into plain declarative while every
   * other settings panel stayed polite, and a user reported the seam directly:
   * "위에는 ~합니다 하다가 밑은 ~한다로 바뀜. 다른 설정 모두 ~합니다로 일관."
   *
   * The old check could not have caught that: `/다\.$/` matches "쓴다." and
   * "씁니다." equally, so it passed either way. It asserts the ENDING now, over
   * every sentence on the tab rather than two sampled keys — the failure was
   * cumulative, and a two-key sample is how half a panel converts.
   *
   * Second-person is part of the same convention: this product's Korean says
   * 나/내 ("naby가 대화에서 나에 대해 기억해 둔 내용…"), never 당신.
   */
  it('ko settings copy is polite ~합니다체 throughout, with no 당신', () => {
    const ko = dict('ko') as { memoryReview: Record<string, string>; bootstrap: Record<string, unknown> };

    // Every sentence-ending across the whole memoryReview namespace. Labels and
    // fragments (no terminal stop) are skipped — the rule is about SENTENCES.
    const offenders: string[] = [];
    for (const [key, value] of Object.entries(ko.memoryReview)) {
      if (typeof value !== 'string') continue;
      for (const sentence of value.match(/[^.!?]+[.!?]/g) ?? []) {
        const s = sentence.trim();
        // A Korean sentence ending in 다 must end in 니다 — the polite form.
        if (/다[.!?]$/.test(s) && !/니다[.!?]$/.test(s)) offenders.push(`${key}: ${s}`);
      }
      if (value.includes('당신')) offenders.push(`${key}: 당신 → 나/내`);
    }
    expect(offenders, `plain-style or 당신 copy on the memory tab:\n  ${offenders.join('\n  ')}`)
      .toEqual([]);

    // The two the user named in the report, pinned individually so a regression
    // names the string rather than only the rule.
    expect(ko.memoryReview.learningHint).toMatch(/니다\.$/);
    expect(ko.memoryReview.summaryEmpty).toMatch(/니다\.$/);
    expect(ko.memoryReview.styleEmpty).toMatch(/니다\.$/);
    expect(String(ko.bootstrap.fastGrowth)).toMatch(/니다\.$/);
  });

  it('ko copy outside the memory tab did not drift back', () => {
    // The sweep left ko.json with NO plain-declarative UI sentence anywhere, and
    // that is the state worth defending: the seam the user saw was one panel
    // written to a different rule from its neighbours, which is a thing that only
    // ever happens one honest addition at a time.
    const ko = dict('ko');
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        for (const sentence of node.match(/[^.!?]+[.!?]/g) ?? []) {
          const s = sentence.trim();
          if (/다[.!?]$/.test(s) && !/니다[.!?]$/.test(s)) offenders.push(`${path}: ${s}`);
        }
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          walk(v, path ? `${path}.${k}` : k);
        }
      }
    };
    walk(ko, '');
    expect(offenders, `plain-style Korean UI copy:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});
