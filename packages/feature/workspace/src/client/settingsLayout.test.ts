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

/** Every panel rendered inside a settings section. */
const PANELS = [
  'NabyAgentManager.tsx',
  'GrowthPanel.tsx',
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
  const EXPECTED: Record<string, number> = {
    theme: 1,
    language: 1,
    provider: 1,
    agents: 3, // agents / telegram escalation / memory
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
    const learning = attrsOf(GROWTH, 'growth-learning');
    expect(learning).toContain('border-t border-border');
    expect(learning).not.toMatch(/rounded-(?:md|lg)/);
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
      'GrowthPanel.tsx',
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

/** Everything from the first section branch to the end of the content pane. */
function contentPane(): string {
  return MODAL.slice(MODAL.indexOf("{section === 'theme'"));
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
