import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A PATH IN A MESSAGE IS CLICKABLE, AND ONLY A MINTED ONE OPENS A FILE.
 *
 * Source assertions, the discipline this directory already uses (`mermaidWiring`,
 * `projectOpenWiring`): the chain runs from a remark plugin through a memoised
 * component table into a singleton bus and out to a tab host, across three
 * packages, and this repo has no harness that renders it. The RULES are pure and
 * tested in `filePathLinks.test.ts`; what is at risk here is the wiring — the
 * feature switched on where it should not be, or the security distinction
 * collapsing into one callback.
 */

const HERE = __dirname;
const UI = join(HERE, '../../../../shared/ui/src');
const AGENT = join(HERE, '../../../agent/src/client');

const read = (p: string) => readFileSync(p, 'utf8');
const RENDERER = read(join(UI, 'MarkdownRenderer.tsx'));
const BUBBLE = read(join(AGENT, 'MessageBubble.tsx'));
const BUS = read(join(AGENT, 'docOpenBus.ts'));
const MANAGER = read(join(HERE, 'TabManager.tsx'));

describe('the feature is opt-in, and only the chat opts in', () => {
  it('is off unless a host asks for it', () => {
    // It changes what ordinary prose renders as. A host that leaves it alone has
    // to get byte-identical markdown to what it got before this existed.
    expect(RENDERER).toContain('enableFileLinks = false');
    expect(RENDERER).toContain(
      'enableFileLinks ? [...remarkPluginsBase, remarkFilePathLinks] : remarkPluginsBase',
    );
  });

  it('is turned on by the message bubble', () => {
    expect(BUBBLE).toContain('enableFileLinks');
  });

  it('is NOT turned on by the document viewer', () => {
    // Inside a document a path is usually a citation, not a destination.
    expect(read(join(HERE, 'MarkdownDocument.tsx'))).not.toContain('enableFileLinks');
  });

  it('rebuilds the component map when the flag changes', () => {
    // Same rule mermaidWiring states for its own flag: a flag left out of the
    // deps only takes effect after some unrelated re-render.
    const deps = /\[isDark, onLinkClick[^\]]*\]/.exec(RENDERER)?.[0];
    expect(deps).toContain('enableFileLinks');
    expect(deps).toContain('onFilePathClick');
  });
});

describe('a minted link cannot be forged', () => {
  it('routes minted links to a DIFFERENT callback than authored ones', () => {
    // The whole security design. `onLinkClick` receives only an href, so a
    // handler on it could not tell a path linkified out of visible text from an
    // authored `[리포트 열기](/Users/you/.ssh/id_rsa)`. Only a link carrying the
    // mark reaches `onFilePathClick`, and only the renderer mints those.
    expect(RENDERER).toContain('onFilePathClick?: (path: string) => boolean;');
    expect(RENDERER).toContain('const minted = (rest as Record<string, unknown>)[FILE_PATH_ATTR];');
    expect(RENDERER).toContain("if (typeof minted === 'string') {");
  });

  it('checks the mark before the href, so an authored path link stays a link', () => {
    // Order matters: the mark is consulted first and returns, so nothing about
    // the href's SHAPE can route an authored link into the file opener.
    const handler = /const minted = [\s\S]*?onLinkClick\?\.\(href\)/.exec(RENDERER)?.[0];
    expect(handler, 'the anchor click handler changed shape').toBeDefined();
    expect(handler!.indexOf('onFilePathClick')).toBeLessThan(handler!.indexOf('onLinkClick'));
  });

  it('links inline code only when the WHOLE span is a path', () => {
    // The motivating case is a path in backticks. Linking a span that merely
    // contains one would describe the click as opening a command.
    expect(RENDERER).toContain('enableFileLinks && isDocumentPath(codeString)');
  });
});

describe('a filesystem href never reaches the browser', () => {
  it('always prevents the default on a file path', () => {
    // Letting the anchor resolve `/Users/…` would navigate the shell to
    // `http://localhost:PORT/Users/…` and lose the live conversation. Both
    // branches prevent unconditionally, handled or not.
    const inline = /if \(enableFileLinks && isDocumentPath\(codeString\)\)[\s\S]*?<\/a>/.exec(
      RENDERER,
    )?.[0];
    expect(inline).toContain('e.preventDefault();');
    expect(inline).toMatch(/e\.preventDefault\(\);\s*\n\s*onFilePathClick\?\./);
  });

  it('is consumed by the bubble even with no tab host mounted', () => {
    expect(BUBBLE).toContain('openDocumentInTab(docTabTarget(path, cwd));');
    expect(BUBBLE).toMatch(/openDocumentInTab\(docTabTarget\(path, cwd\)\);\s*\n\s*return true;/);
  });
});

describe('the message reaches the tab host', () => {
  it('goes through a singleton bus, not a prop drill', () => {
    // Four components deep, and the bubble is memo'd against exactly the prop
    // churn a threaded callback would add.
    expect(BUS).toContain('export function openDocumentInTab');
    expect(BUS).toContain('export function setActiveDocOpener');
    expect(MANAGER).toContain('setActiveDocOpener(open)');
    expect(MANAGER).toContain('return () => clearActiveDocOpener(open)');
  });

  it('releases only its own registration', () => {
    // The identity check `fileRefBus` uses: a remount whose effect ordering puts
    // the new registration before the old cleanup must not end up with none.
    expect(BUS).toContain('if (activeOpener === fn) activeOpener = null');
  });

  it('opens against the root the REQUEST names, not the project', () => {
    // A document outside the project is opened against its own folder — which is
    // what lets ~/Downloads open with the server's containment guard untouched.
    expect(MANAGER).toContain('({ cwd, rel }: DocOpenRequest) => openMarkdownTab(cwd, rel)');
    expect(MANAGER).not.toMatch(/DocOpenRequest\) => openMarkdownTab\(initialCwd/);
  });

  it('hands the bubble a stable callback', () => {
    // The renderer memoises its component table on this identity; a fresh
    // closure per render would rebuild the message's DOM on every stream delta.
    expect(BUBBLE).toMatch(/const handleFilePathClick = useCallback\([\s\S]*?\[cwd\],\s*\);/);
    expect(BUBBLE).toContain('onFilePathClick={handleFilePathClick}');
  });
});
