import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Settings modal's shape, asserted against the source.
 *
 * Source assertions rather than rendering ones, for the same reason as
 * `sidebarPopoverClipping.test.ts`: every fact here is pure layout — where a
 * border is drawn, how wide the panel scales — and jsdom has no layout engine, so
 * a mounted test would happily "see" a modal the browser draws at half the size.
 *
 * WHAT THIS FILE NOW DEFENDS. The sections used to be CARDS. Each one drew a
 * rounded border and a tint, and every naby panel inside them drew its own
 * bordered intro paragraph, its own bordered sub-panels and its own bordered
 * rows — so the pane became boxes inside boxes inside boxes. The contract that
 * replaced it:
 *
 *   1. A section is a flat text header plus its content. No border, no tint.
 *   2. The full-width rule BETWEEN sections is drawn by the content pane
 *      (`divide-y`), so the first section has none above it and the last none
 *      below.
 *   3. Inside a panel, a border belongs to a single interactive row or a repeated
 *      list item. Descriptions, status readouts and group wrappers get spacing,
 *      an inset divider or a left accent — never a box.
 *
 * Rule 3 is the one that will rot, because every new panel is written in
 * isolation and a box is the easiest way to make something "look grouped". The
 * assertions below are therefore aimed at the exact places it was violated: the
 * description paragraph at the top of every naby panel, and the panels that open
 * INSIDE an agent row (which is already the one card the list is allowed).
 */

const DIR = __dirname;

/**
 * A source file with its comments removed.
 *
 * Every assertion here is about CLASS NAMES, and the files now carry paragraphs
 * explaining which class names were taken away — so a naive scan reads "a border
 * and a tint" in a comment and fails the test that checks there is no border.
 * Block comments (which is what the JSX `{/* … *\/}` form compiles to) and
 * whole-line `//` comments are dropped; trailing `//` is left alone so a URL or a
 * `bg-amber-500/10` in code is never truncated.
 */
const read = (f: string) =>
  readFileSync(join(DIR, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const MODAL = read('SettingsModal.tsx');
const SECTION = read('SettingsSection.tsx');
const DETAILS = read('SettingsDetails.tsx');
const DEV_MODE = read('DevModePanel.tsx');

/** The locale dictionaries, for the copy-length rules below. */
const LOCALES = ['en', 'ko'] as const;
const dict = (locale: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(DIR, '../../../..', 'shared/i18n/locales', `${locale}.json`), 'utf8')
  );

const lookup = (d: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>((cur, part) => {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      return (cur as Record<string, unknown>)[part];
    }
    return undefined;
  }, d);

/**
 * How many sentences a string ends.
 *
 * Counts `.`/`!`/`?` that are followed by a space or the end of the string, so
 * the dots inside `~/.claude/skills`, `mcp__jira__*` and `1.0.0` are not read as
 * sentence ends. Works for both locales — Korean UI copy uses the same stops.
 */
const sentences = (s: string): number => (s.match(/[.!?](?=\s|$)/g) ?? []).length;

/** Every panel rendered inside a settings section, plus the two overlays those
 *  panels open (the memory browser has its own file; the growth REPORT is new in
 *  settings-ia-reorg §3.2 and inherits the same no-box rules — it is read-only,
 *  which is a reason to have fewer frames, not more). */
const PANELS = [
  'NabyAgentManager.tsx',
  'GrowthPanel.tsx',
  'GrowthReportModal.tsx',
  'NabyTelegramSettings.tsx',
  'NabyMemoryReview.tsx',
  'NabyHarnessReview.tsx',
  'NabyCommandManager.tsx',
  'NabyPolicyManager.tsx',
  'NabyProviderSetup.tsx',
  'AgentExportButton.tsx',
  'AgentImportButton.tsx',
  'UpdatePanel.tsx',
  'DevModePanel.tsx',
] as const;

describe('a section is flat, not a card', () => {
  it('draws no border, no rounding and no tint of its own', () => {
    // The three things that made it a card. A section that reintroduces any of
    // them puts every panel below it one level deeper again.
    expect(SECTION).not.toMatch(/rounded-(?:sm|md|lg|xl|full)/);
    expect(SECTION).not.toMatch(/\bborder(?:-[trbl])?\b/);
    expect(SECTION).not.toMatch(/\bbg-(?:muted|card|accent|background)/);
  });

  it('keeps the header typography that replaced the card header', () => {
    expect(SECTION).toContain('text-sm font-semibold text-foreground');
    expect(SECTION).toContain('text-xs text-muted-foreground');
  });

  it('yields its outer padding when it is first or last in the pane', () => {
    // The pane draws the rule BETWEEN sections; these are the matching half, so
    // the top section does not start with a gap and a lone section adds none at
    // all. Without them a single-section pane looks vertically off-centre.
    expect(SECTION).toContain('first:pt-0');
    expect(SECTION).toContain('last:pb-0');
  });

  it('is declared at module scope', () => {
    // Declared inside SettingsModal it would be a new component type on every
    // render, remounting every naby panel below it — and each one refetches on
    // mount, so the modal would flicker and lose state on any keystroke.
    expect(SECTION).toMatch(/^export function SettingsSection/m);
  });
});

describe('the content pane owns the separator between sections', () => {
  const paneClass = /className="flex-1 min-w-0 overflow-y-auto ([^"]+)"/.exec(MODAL)?.[1];

  it('divides its children with a full-width rule', () => {
    expect(paneClass, 'content pane className not found — did the markup change?').toBeDefined();
    expect(paneClass).toContain('divide-y divide-border');
  });

  it('renders sections as DIRECT children, never inside a group wrapper', () => {
    // `divide-y` only reaches siblings. A `<div className="space-y-4">` around
    // the Agents / Harness / About groups — which is how they were written when
    // sections were cards — would swallow all three into one child and silently
    // erase every divider.
    const pane = contentPane();
    expect(pane).not.toMatch(/<div className="space-y-\d+">\s*<SettingsSection/);
  });

  it('leaves no bare <label> headings behind in the content pane', () => {
    // The section header replaced them. A stray one is a section that was missed.
    expect(contentPane()).not.toContain('<label');
  });
});

describe('every settings block is a section', () => {
  // section id → how many sections it should render.
  //
  // THE 2026-08-04 REGROUP (settings-ia-reorg §3.1). Every change below is a MOVE
  // — the same components, mounted under a different nav row — so the totals
  // still add up to what they were plus nothing:
  //
  //   theme(1) + language(1)  →  general(2)     two one-control tabs merged.
  //   provider(1)             →  provider(1)    unchanged in COUNT, but the MCP
  //                                             halves left `NabyProviderSettings`
  //                                             for the tab below.
  //   —                       →  connections(2) MCP servers (the component that
  //                                             was inside provider) + Telegram
  //                                             (which was inside agents).
  //   agents(3)               →  agents(1)      telegram and memory moved out.
  //   —                       →  memory(1)      its own tab. (It carried a count
  //                                             on its nav row for one build; see
  //                                             the IA-3 block below.)
  //
  // Anything that is NOT a move would show up here as a total that grew.
  const EXPECTED: Record<string, number> = {
    general: 2, // theme + language, merged
    provider: 1, // engine choice + API keys; MCP moved to connections
    connections: 2, // MCP servers (system presets + user-added) / telegram
    agents: 1, // the naby agent list; its memory and telegram moved out
    memory: 1, // the memory tab (decisions inbox, switches, browser)
    harness: 2, // harness review / commands
    permissions: 1,
    about: 2, // version + updates; dev mode brings its own (see below)
  };

  for (const [id, count] of Object.entries(EXPECTED)) {
    it(`${id} renders ${count} section(s)`, () => {
      const block = sectionBlock(id);
      expect(block, `section '${id}' not found in SettingsModal`).toBeTruthy();
      expect(occurrences(block, '<SettingsSection')).toBe(count);
    });
  }

  it('lets DevModePanel wrap itself, so an unavailable build shows nothing', () => {
    // It returns null when the build has no dev-mode door; a section supplied by
    // the caller would leave an empty titled block — and a dangling divider — in
    // its place.
    expect(DEV_MODE).toContain('<SettingsSection');
    expect(DEV_MODE).toContain('if (!bridge() || !status?.available) return null;');
    const about = sectionBlock('about');
    expect(about).toContain('<DevModePanel />');
    expect(about).not.toMatch(/<SettingsSection[^>]*>\s*<DevModePanel/);
  });

  it('draws no hand-rolled divider anywhere — the pane does it', () => {
    // Two sources of the same rule is how About ended up with a divider above it
    // and a card around it at the same time.
    expect(MODAL).not.toContain('mt-6 pt-4 border-t border-border');
    expect(DEV_MODE).not.toContain('border-t border-border');
  });
});

describe('no panel wraps its description in a box', () => {
  // THE EXACT VIOLATION THAT PROMPTED THIS. Seven panels opened with the same
  // `rounded-md border border-border bg-muted/40` paragraph, so selecting Agents
  // drew a card, then a tinted box, then the agent rows — three frames before any
  // content. A description is muted text under the heading; nothing else.
  for (const file of PANELS) {
    it(`${file} states its description as plain muted text`, () => {
      const src = read(file);
      expect(src).not.toContain('bg-muted/40');
      expect(src).not.toContain('bg-muted/30');
      expect(src).not.toContain('bg-muted/20');
    });
  }
});

describe('nothing draws a card inside the agent row', () => {
  // An agent is a repeated list item, so IT gets the border (that is what a
  // border is still for). Everything that expands inside it — the delegation
  // settings, the growth panel, the export confirmation — is therefore already
  // one level deep and must separate itself with a rule or a left accent.
  const AGENTS = read('NabyAgentManager.tsx');
  const GROWTH = read('GrowthPanel.tsx');
  const REPORT = read('GrowthReportModal.tsx');
  const EXPORT = read('AgentExportButton.tsx');
  const IMPORT = read('AgentImportButton.tsx');

  it('the delegation settings open with a divider', () => {
    expect(AGENTS).toContain('mt-2.5 border-t border-border pt-2.5');
    expect(AGENTS).not.toMatch(/rounded-md border border-border/);
  });

  it('the growth panel opens with a divider, in every state', () => {
    const root = attrsOf(GROWTH, 'growth-panel');
    expect(root, 'growth-panel testid not found').toBeTruthy();
    expect(root).toContain('border-t border-border');
    expect(root).not.toMatch(/rounded-(?:md|lg)/);
    // Loading and unavailable are one sentence each; they used to render the
    // same bordered, tinted box as the full panel.
    expect(GROWTH).not.toMatch(/rounded-lg border border-border/);
  });

  it('the reason line is a left accent, not a coloured box', () => {
    // It still has to stand apart — it is the sentence a falling meter owes its
    // user — but a 2px edge says that without a fourth rectangle.
    const reason = attrsOf(GROWTH, 'growth-reason');
    expect(reason).toContain('border-l-2');
    expect(reason).not.toMatch(/bg-amber-500\/10/);
  });

  it('the learning block is a heading under a rule, not a panel', () => {
    // IT LIVES IN THE REPORT NOW (settings-ia-reorg §3.2), not in the row — the
    // rule is unchanged and follows the block, because the reason for it is
    // unchanged too: a bordered, tinted box would make these counts read as a
    // second scoreboard beside the gauge.
    const learning = attrsOf(REPORT, 'growth-learning');
    expect(learning, 'growth-learning testid not found in the report').toBeTruthy();
    expect(learning).toContain('border-t border-border');
    expect(learning).not.toMatch(/rounded-(?:md|lg)/);
    // And it is NOT left behind in the row as well: two copies of a disowning
    // sentence is how the two stop agreeing.
    expect(GROWTH).not.toContain('data-testid="growth-learning"');
  });

  it('the export and import confirmations use the same left accent', () => {
    // Same kind of surface — "here is what is about to move, confirm it" — so
    // they get the same treatment. The export one opens inside the agent row.
    const exportRoot = attrsOf(EXPORT, 'agent-export-confirm');
    const importRoot = attrsOf(IMPORT, 'agent-import-confirm');
    expect(exportRoot).toContain('border-l-2 border-amber-500/60');
    expect(importRoot).toContain('border-l-2 border-sky-500/60');
    for (const root of [exportRoot, importRoot]) {
      expect(root).not.toMatch(/rounded-lg/);
    }
  });
});

/**
 * IA-2 — THE GROWTH REPORT LEFT THE SETTINGS PANE (settings-ia-reorg §3.2).
 *
 * The panel that expanded inside the agent row was a read-only dashboard 35–60
 * lines long with two unbounded lists in it, sitting in the middle of a screen of
 * switches. It is now an overlay, and the row keeps the three things a person
 * reads at a glance. These assertions defend BOTH halves: that the row really is
 * three lines and two buttons, and that everything taken out of it still exists
 * somewhere the user can reach.
 */
describe('the growth report is an overlay, and the row is a summary', () => {
  const GROWTH = read('GrowthPanel.tsx');
  const REPORT = read('GrowthReportModal.tsx');
  const AGENTS = read('NabyAgentManager.tsx');

  it('stacks where the memory browser stacks', () => {
    // Above SettingsModal (z-50, which contains the row it was opened from) and
    // below the z-[200] toast/context-menu layer. Two overlays opened from the
    // same pane behaving differently would be worse than either choice.
    expect(REPORT).toContain('fixed inset-0 z-[100]');
    expect(REPORT).toContain('h-[85vh]');
    expect(REPORT).toContain('overflow-y-auto');
  });

  it('closes on Escape and on a backdrop click', () => {
    expect(REPORT).toContain("e.key === 'Escape'");
    expect(REPORT).toMatch(/absolute inset-0 bg-black\/50[^]*onClick=\{onClose\}/);
  });

  it('keeps the row to the stage, the gauge, the reason and two buttons', () => {
    // The exact list from §3.2. Anything else creeping back onto the row is the
    // regression this file exists to catch — the panel got long one honest
    // addition at a time.
    expect(GROWTH).toContain('data-testid="growth-panel"');
    expect(GROWTH).toContain("t('growth.eggHint'"); // the gauge's egg-stage half
    expect(GROWTH).toContain('data-testid="growth-reason"');
    expect(GROWTH).toContain("t('growth.report.open'");
    expect(GROWTH).toContain("t('growth.fastSession.button'");
    // The moved blocks are NOT rendered twice.
    for (const gone of [
      "t('growth.axis.hitRate'",
      "t('growth.byTaskType'",
      "t('growth.recent'",
      "t('growth.howItMoves'",
      "t('growth.secondTier'",
    ]) {
      expect(GROWTH, `${gone} should have moved to the report`).not.toContain(gone);
      expect(REPORT, `${gone} missing from the report`).toContain(gone);
    }
  });

  it('opens from the row button and closes back to it', () => {
    // The whole state machine, since there is no DOM in these tests: the button
    // sets it, the modal is handed it, the modal's own close resets it, and a
    // closed modal renders nothing at all (rather than an invisible overlay
    // swallowing clicks on the settings pane behind it).
    expect(GROWTH).toContain('setReportOpen(true)');
    expect(GROWTH).toContain('isOpen={reportOpen}');
    expect(GROWTH).toContain('onClose={() => setReportOpen(false)}');
    expect(REPORT).toContain('if (!isOpen) return null;');
  });

  it('reads the record ONCE and hands it to the report', () => {
    // Two fetches of the same document would put two answers of the same
    // question on one screen for as long as the second one took to arrive.
    expect(GROWTH).toContain("action: 'growth.get'");
    expect(REPORT).not.toContain("action: 'growth.get'");
    expect(GROWTH).toContain('<GrowthReportModal');
  });

  it('shows the summary without a toggle, and drops the old Growth button', () => {
    // The 35–60 line panel is what justified hiding it behind a button; three
    // lines that say which stage the agent is at do not, and an agent whose
    // stage is behind a click is the one number this product is about, hidden.
    // Matched loosely across newlines: the element grew a prop (`onLeaveSettings`,
    // for the fast-growth navigation) and had to be broken over several lines.
    // What matters is that the row still mounts the summary unconditionally.
    expect(AGENTS).toMatch(/<GrowthPanel\s+agentId=\{agent\.id\}/);
    expect(AGENTS).not.toContain('setShowGrowth');
    expect(AGENTS).not.toContain("t('agentManager.growth'");
  });
});

/**
 * IA-3 — THE NAV CARRIES NO BADGE, AND THE COUNT LIVES ON THE INBOX
 * (settings-ia-reorg §3.3a).
 *
 * WHAT WAS TRIED AND WITHDRAWN. The memory row carried a count of the decisions
 * waiting for the user. It was reported as unreadable the day it shipped —
 * "'1'은 무슨 의미죠?" — because a bare number beside a label is a number with no
 * noun. The repair was a `title`/`aria-label` sentence on the badge, and it
 * failed for a reason no source assertion could have caught: the app runs in
 * Electron, where that tooltip never appeared. So the explanation existed only
 * on a surface the user could not reach, and the badge went.
 *
 * THE COUNT DID NOT GO WITH IT. The second half of that fix — the inbox heading
 * inside the memory tab, which states the same number over the very rows it
 * counts — is now the only place it is spoken, and it is the half that always
 * worked: a number with its noun, its list and its actions on one screen.
 *
 * Both halves are asserted here, because either one alone regresses the user's
 * report: a badge coming back, or the heading quietly going away.
 */
describe('the nav shows no count, and the memory tab states it instead', () => {
  const CARD = read('NabyMemoryReview.tsx');

  it('draws no badge on any nav row', () => {
    // The element, its testid and the state that fed it — all three, so a partial
    // revert (the span without the testid, say) is still a failure.
    expect(MODAL).not.toContain('settings-memory-badge');
    expect(MODAL).not.toMatch(/pending > 0/);
    expect(MODAL).not.toMatch(/\bsetPending\b/);
  });

  it('says nothing about a pending count in a tooltip, in the modal or in a locale', () => {
    // The tooltip was the part that could not work in Electron. The key is gone
    // from both dictionaries so nothing can quietly render it again.
    expect(MODAL).not.toContain('pendingBadgeTitle');
    for (const locale of LOCALES) {
      expect(
        lookup(dict(locale), 'memoryReview.pendingBadgeTitle'),
        `pendingBadgeTitle should be gone from ${locale}.json`,
      ).toBeUndefined();
    }
  });

  it('opens no read of its own for a number it no longer shows', () => {
    // The modal used to fetch the summary on open purely to feed the badge (the
    // panel mounts only while its own tab is selected, so it could not supply
    // it). With nothing to feed, that request is not made — and no timer replaced
    // it either.
    expect(MODAL).not.toContain('fetchMemorySummary');
    expect(MODAL).not.toMatch(/setInterval/);
    // The panel's own read is untouched: it is what the heading below counts on.
    expect(CARD).toContain('export async function fetchMemorySummary');
  });

  it('states the count on the inbox heading, from the pendingCount field', () => {
    // THE SURVIVING HALF. Read from `pendingCount` and NOT from the lengths of
    // the three lists, which are capped for size: a heading saying 3 over 12
    // waiting decisions would be the badge's problem in a longer sentence.
    expect(CARD).toContain('data-testid="memory-inbox-heading"');
    expect(CARD).toContain(
      "t('memoryReview.summaryPendingCount', { count: summary?.pendingCount ?? 0 })",
    );
    for (const locale of LOCALES) {
      expect(String(lookup(dict(locale), 'memoryReview.summaryPendingCount') ?? '')).toContain(
        '{{count}}',
      );
    }
  });

  it('keeps the heading absent when the inbox is empty', () => {
    // A "0 waiting for you" heading over no rows is a permanent ornament — the
    // same thing hiding the badge at zero was avoiding.
    expect(CARD).toMatch(/\{hasInbox \? \(/);
    const inbox = CARD.slice(CARD.indexOf('{hasInbox ? ('));
    expect(inbox.indexOf('memory-inbox-heading')).toBeGreaterThan(-1);
  });
});

/**
 * IA-4 — THE FAST-GROWTH BUTTON GOES SOMEWHERE (fast-evolution §3.3).
 *
 * THE REPORT THIS IS WRITTEN AGAINST. The user pressed "빠른 성장 세션" in two
 * successive builds and, both times, could not say what it was or what had
 * happened. Three separate failures produced that, and this block pins the fix
 * for each one so they cannot come back independently:
 *
 *   a. NOTHING SAID WHAT IT WAS before the click. The explanation lived in a
 *      `title`, i.e. behind a hover on a control nobody hovers over.
 *   b. NOTHING TOOK THEM THERE. The button created a session and printed
 *      "it is at the top of your session list", which is a treasure map.
 *   c. THE SESSION LOOKED LIKE EVERY OTHER SESSION — untitled, named later from
 *      its first message (covered in `naby.test.ts`, at the route that mints it).
 */
describe('the fast-growth button explains itself and opens what it creates', () => {
  const GROWTH = read('GrowthPanel.tsx');
  const AGENTS = read('NabyAgentManager.tsx');

  it('states what it is in the open, not in a tooltip', () => {
    // The hint is RENDERED, and the `title` that remains carries the weighting
    // caveat instead — a different string, deliberately, so "it is explained"
    // cannot be satisfied by moving the same sentence back into the attribute.
    expect(GROWTH).toContain('data-testid="growth-fast-session-hint"');
    const hintAt = GROWTH.indexOf('data-testid="growth-fast-session-hint"');
    expect(GROWTH.slice(hintAt, hintAt + 400)).toContain("t('growth.fastSession.hint'");
    expect(GROWTH).toContain("title={t('growth.fastSession.weight'");
    expect(GROWTH).not.toContain("title={t('growth.fastSession.hint'");
  });

  it('opens the session it just created, over the existing bus', () => {
    // NO NEW NAVIGATION INFRASTRUCTURE: `Topics.OpenProject` is what the session
    // rows in SessionBrowser and ProjectSessionsModal already publish, and
    // Workspace's listener is what switches the project and posts SWITCH_SESSION
    // into its iframe. Settings renders in that same top window, so a plain
    // `publishTopic` reaches it.
    expect(GROWTH).toContain("import { publishTopic } from '@cockpit/effect-react'");
    expect(GROWTH).toContain('publishTopic(Topics.OpenProject, { cwd, sessionId: json.sessionId })');
    // …and gets out of the way afterwards. A modal left open over the session it
    // just opened is the same "nothing visibly happened" the button already had.
    expect(GROWTH).toContain('onLeaveSettings?.()');
  });

  it('closes Settings only AFTER the open request went out', () => {
    // Order matters: dismissing the pane first would leave a user staring at the
    // workspace with no session if the create failed.
    const body = GROWTH.slice(GROWTH.indexOf('const startFastGrowth'));
    const publishAt = body.indexOf('publishTopic(Topics.OpenProject');
    const closeAt = body.indexOf('onLeaveSettings?.()');
    expect(publishAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(publishAt);
    // And never on the failure path.
    expect(body.indexOf("setDrillSession('failed')")).toBeGreaterThan(-1);
  });

  it('degrades honestly when there is no project to open into', () => {
    // `cwd` is the open project and Workspace keys the whole open path on it.
    // With none there is nowhere to navigate, so the button says CREATED rather
    // than claiming it opened something — the previous version's exact mistake,
    // one branch further along.
    expect(GROWTH).toContain("setDrillSession('created-not-opened')");
    expect(GROWTH).toContain("t('growth.fastSession.createdNoOpen'");
    for (const locale of LOCALES) {
      for (const key of ['growth.fastSession.createdNoOpen', 'growth.fastSession.weight']) {
        expect(String(lookup(dict(locale), key) ?? ''), `${key} missing from ${locale}.json`).not.toBe('');
      }
    }
  });

  it('names the session it creates, in the user language', () => {
    // The server has no locale (the same reason harness pills carry codes), so
    // the title travels from here. The route's half — that it lands on the row
    // AND on the rename key, so auto-titling cannot overwrite it — is asserted in
    // `api/naby.test.ts`.
    expect(GROWTH).toContain("title: t('growth.fastSession.sessionTitle'");
    for (const locale of LOCALES) {
      expect(
        String(lookup(dict(locale), 'growth.fastSession.sessionTitle') ?? ''),
        `sessionTitle missing from ${locale}.json`,
      ).not.toBe('');
    }
  });

  it('is handed the modal close through a STABLE identity', () => {
    // `AgentRow` is memo'd and this prop originates as an inline arrow in
    // Workspace, so passing it straight down would make every agent row re-render
    // on every render of the app shell (shell/CLAUDE.md's referential-stability
    // rule). The ref indirection is the same one NabyMemoryReview uses.
    expect(AGENTS).toContain('const leaveSettings = useRef(onLeaveSettings)');
    expect(AGENTS).toContain('useCallback(() => leaveSettings.current?.(), [])');
    expect(AGENTS).toContain('onLeaveSettings={handleLeaveSettings}');
    expect(MODAL).toContain('onLeaveSettings={onClose}');
  });
});

describe('the harness set tools do not frame themselves inside the disclosure', () => {
  const HARNESS = read('NabyHarnessReview.tsx');

  it('keeps the <details> border and drops the panel border inside it', () => {
    // The disclosure summary is an interactive row, so it keeps its border; the
    // tools rendered inside it drew a second frame one pixel in.
    expect(HARNESS).toContain('<details className="rounded-lg border border-border">');
    expect(HARNESS).not.toContain('space-y-4 rounded-lg border border-border p-3');
  });

  it('separates the loaded-set selection with a rule', () => {
    expect(HARNESS).toContain('space-y-2 border-t border-border pt-2.5');
  });

  it('states the import result as prose, not as a panel', () => {
    expect(HARNESS).not.toContain('rounded-lg border border-border p-2.5 space-y-1');
  });
});

describe('warnings are accents, not boxes', () => {
  const PROVIDER = read('NabyProviderSetup.tsx');

  it('the insecure-backend banner reads the same in the wizard card', () => {
    // It renders both in the settings section and inside the onboarding card;
    // in the card a bordered, tinted rectangle was a box within a box.
    expect(PROVIDER).toContain('border-l-2 border-amber-500/60 pl-2.5');
    expect(PROVIDER).not.toContain('rounded border border-amber-500/50 bg-amber-500/10');
  });
});

describe('modal width scales with the window', () => {
  const panelClass = /className="relative bg-card rounded-lg shadow-xl ([^"]+)"/.exec(MODAL)?.[1];

  it('is proportional with a hard minimum, not a fixed max', () => {
    expect(panelClass, 'modal panel className not found — did the markup change?').toBeDefined();
    expect(panelClass).not.toContain('max-w-4xl');
    expect(panelClass).toContain('w-[min(86vw,1600px)]');
    // Floor, but never wider than the viewport minus the mx-4 gutters. The
    // Electron window's own minWidth (electron/boot.ts) is set above this floor
    // plus its gutters, so the modal never has to yield in the desktop app.
    expect(panelClass).toContain('min-w-[min(880px,calc(100vw-2rem))]');
  });

  it('keeps the height and gutter behaviour', () => {
    expect(panelClass).toContain('h-[85vh]');
    expect(panelClass).toContain('mx-4');
  });

  it('keeps the narrow-window stacking of nav and content', () => {
    // The nav becomes a horizontal strip below `sm`; a proportional width must
    // not be read as permission to drop that.
    expect(MODAL).toContain('flex flex-col sm:flex-row flex-1 min-h-0');
  });

  it('keeps the button grids hand-sized inside the now-wide pane', () => {
    // Three theme tiles stretched across 1600px would read as billboards.
    expect(occurrences(MODAL, 'grid grid-cols-3 gap-2 max-w-md')).toBe(2);
  });
});

/**
 * THE SECOND THING THIS PANE KEPT ACCUMULATING: words.
 *
 * The box problem above has a twin. Every panel was written on its own, each one
 * opening with a paragraph that explained what it is, then how it works, then the
 * caveat, then the syntax — and the harness list rendered, per card, a full
 * frontmatter description plus a preview of the item's instructions plus its
 * trust tier plus its absolute origin path. Twenty skills was twenty paragraphs,
 * with the enable button (the only reason anyone opens that panel) below all of
 * it. Nothing here is wrong in isolation; the failure is cumulative, which is
 * exactly the kind a reviewer of a single diff will not catch.
 *
 * THE CONTRACT, from the published guidance these panels are now written against
 * (NN/g progressive disclosure and info-tips, Microsoft's settings guidance,
 * Material's three-line ceiling for list items, GOV.UK hint text, Polaris "weigh
 * every word"):
 *
 *   1. A panel's visible description is ONE sentence.
 *   2. A list-item card shows a title plus at most one clamped line of support;
 *      the rest is on demand.
 *   3. Supplemental prose lives behind ONE shared expander, not a per-panel
 *      hand-rolled one and not a second level.
 *
 * Rule 1 is asserted against the LOCALE FILES rather than the sources, because
 * that is where the sentences actually get added, and because a rule that only
 * held in English would leave Korean users reading the wall this removed.
 */
describe('a panel introduces itself in one sentence', () => {
  // Every string a settings panel renders as its standing description or intro
  // hint. Adding a panel means adding its key here.
  const INTRO_KEYS = [
    'harnessReview.description',
    'harnessReview.reviewNote',
    'harnessReview.autoScanHint',
    'memoryReview.description',
    'telegramSettings.description',
    'policyManager.description',
    'agentManager.description',
    // The line that stands where "+ Add agent" used to (2026-08-03): custom-agent
    // creation is gone from the UI, and the panel now points at harness subagents
    // instead. It is a standing hint, so it lives under the same one-sentence rule.
    'agentManager.subagentHint',
    'agentManager.delegationHint',
    'commandManager.description',
    'systemMcp.description',
    'growth.howItMoves',
    'growth.learning.notTheGauge',
    // settings-ia-reorg §3.3 — the four ways a memory comes to exist, one
    // sentence each. They are the standing hint of the "how it learns" group,
    // and four of them is exactly why each one has to stay a single sentence:
    // the group is four lines, or it is the wall this rule removed.
    'memoryReview.channelProposal',
    'memoryReview.channelCorroboration',
    'memoryReview.channelReflection',
    'memoryReview.channelStyle',
    // The sentence the cold-start card ends on, pointing at the fast-growth
    // session — a standing hint under the same rule.
    'bootstrap.fastGrowth',
    // WHAT THE FAST-GROWTH BUTTON IS. It used to be a `title`, and a tooltip is
    // not an explanation — the user pressed the button twice, across two builds,
    // and still could not say what it did. It is standing prose in the row now,
    // so it falls under the one-sentence rule like every other intro; the
    // discount caveat that shared the old string stayed on the control as
    // `growth.fastSession.weight`, which is where a second-order fact belongs.
    'growth.fastSession.hint',
  ] as const;

  for (const locale of LOCALES) {
    const d = dict(locale);
    for (const key of INTRO_KEYS) {
      it(`${locale}: ${key} is one sentence`, () => {
        const value = String(lookup(d, key) ?? '');
        expect(value, `${key} missing from ${locale}.json`).not.toBe('');
        expect(
          sentences(value),
          `${key} (${locale}) is ${sentences(value)} sentences:\n  ${value}`
        ).toBeLessThanOrEqual(1);
      });
    }
  }

  it('keeps the moved text, rather than deleting the explanation outright', () => {
    // The shortening is progressive disclosure, not amnesia: what was cut from an
    // intro has to still exist somewhere the user can reach. A missing key here
    // means a sentence was dropped on the floor.
    for (const locale of LOCALES) {
      const d = dict(locale);
      for (const key of [
        'settings.moreDetails',
        'memoryReview.proposedNote',
        'telegramSettings.setupNote',
        'policyManager.syntaxNote',
        'agentManager.personaNote',
        'commandManager.engineNote',
        'systemMcp.detailsNote',
        'growth.howItMovesMore',
      ]) {
        expect(String(lookup(d, key) ?? ''), `${key} missing from ${locale}.json`).not.toBe('');
      }
    }
  });
});

describe('the shared disclosure is flat, and is the only one panels roll', () => {
  it('draws no border, rounding or tint of its own', () => {
    // It very often opens INSIDE a list-item card, which already has the one
    // border this pane allows. A frame in there is card-in-card again — the same
    // violation as a section that draws a box, one level deeper. Asserted on the
    // individual utility TOKENS: `border-border` is a colour and legitimate,
    // while a bare `border` is the all-sides box this must never draw.
    const tokens = classTokens(DETAILS);
    expect(tokens).not.toContain('border');
    for (const side of ['border-r', 'border-b', 'border-l']) {
      expect(tokens).not.toContain(side);
    }
    expect(tokens.filter((c) => c.startsWith('rounded'))).toEqual([]);
    expect(tokens.filter((c) => /^bg-(?:muted|card|accent|background)/.test(c))).toEqual([]);
    // The rule that separates the disclosed text from what sits above it — the
    // thing it uses INSTEAD of a box.
    expect(DETAILS).toContain('border-t border-border');
  });

  it('is declared at module scope', () => {
    // Same reason as SettingsSection: a type created during render remounts
    // everything below it, and these panels refetch on mount.
    expect(DETAILS).toMatch(/^export function SettingsDetails/m);
  });

  it('is collapsed by default', () => {
    // `open` would make the disclosure decorative — the wall would be back, with
    // a triangle in front of it.
    expect(DETAILS).not.toMatch(/<details[^>]*\bopen\b/);
  });

  it('is what the panels use for their supplemental prose', () => {
    for (const file of [
      'NabyHarnessReview.tsx',
      'NabyMemoryReview.tsx',
      'NabyTelegramSettings.tsx',
      'NabyPolicyManager.tsx',
      'NabyAgentManager.tsx',
      'NabyCommandManager.tsx',
      'NabyProviderSetup.tsx',
      // The growth panel's supplemental prose (`howItMovesMore`) travelled with
      // the rest of the report, so the disclosure it uses travelled too.
      'GrowthReportModal.tsx',
    ]) {
      const src = read(file);
      expect(src, `${file} does not use the shared disclosure`).toContain('<SettingsDetails>');
    }
  });
});

describe('a harness card shows a name and a state, not a document', () => {
  const HARNESS = read('NabyHarnessReview.tsx');

  /** The card markup: from the row component to the end of its return. */
  const CARD = HARNESS.slice(HARNESS.indexOf('const HarnessRow = memo'));
  const COLLAPSED = CARD.slice(0, CARD.indexOf('<SettingsDetails>'));
  const EXPANDED = CARD.slice(CARD.indexOf('<SettingsDetails>'));

  it('clamps the description to a single line', () => {
    // It renders the item's frontmatter description verbatim, which is written by
    // whoever authored the skill and is routinely a paragraph.
    expect(COLLAPSED).toContain('line-clamp-1');
  });

  it('keeps the enable and delete buttons on the collapsed card', () => {
    // The entire point of the panel. Behind an expander they would be one click
    // further away than before the change.
    expect(COLLAPSED).toContain("t('harnessReview.enable')");
    expect(COLLAPSED).toContain("t('harnessReview.delete')");
  });

  it('moves the instructions preview and the provenance behind the expander', () => {
    // These three were the bulk of the wall: a preview of the item's body, its
    // trust tier and its absolute path, on every card.
    expect(COLLAPSED).not.toContain("t('harnessReview.trustLabel')");
    expect(COLLAPSED).not.toContain("t('harnessReview.originLabel')");
    expect(COLLAPSED).not.toContain('whitespace-pre-wrap');
    expect(EXPANDED).toContain("t('harnessReview.trustLabel')");
    expect(EXPANDED).toContain("t('harnessReview.originLabel')");
    expect(EXPANDED).toContain('whitespace-pre-wrap');
  });

  it('keeps the tool-bearing caveat visible', () => {
    // Task-critical, not supplemental: it says that enabling this particular item
    // does not yet give a working capability, and the button that does the
    // enabling is right there.
    expect(COLLAPSED).toContain("t('harnessReview.needsPhase25')");
  });
});

/** Everything from the first section branch to the end of the content pane.
 *  `general` is the first branch since the regroup (it holds theme + language). */
function contentPane(): string {
  return MODAL.slice(MODAL.indexOf("{section === 'general'"));
}

/** The JSX for one `{section === '<id>' ? ( … ) : null}` branch. */
function sectionBlock(id: string): string {
  const start = MODAL.indexOf(`{section === '${id}'`);
  if (start === -1) return '';
  const rest = MODAL.slice(start + 1);
  const end = rest.indexOf('{section === ');
  return end === -1 ? rest : rest.slice(0, end);
}

/** The opening tag of the element carrying `data-testid="<id>"`, up to the testid
 *  itself — i.e. its className, however it was written (literal or template). */
function attrsOf(src: string, testId: string): string {
  const at = src.indexOf(`data-testid="${testId}"`);
  if (at === -1) return '';
  return src.slice(src.lastIndexOf('<', at), at);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Every individual utility class used in a source file's literal classNames. */
function classTokens(src: string): string[] {
  return [...src.matchAll(/className="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean);
}
