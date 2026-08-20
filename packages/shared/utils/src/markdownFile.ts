/**
 * markdownFile.ts — "is this thing markdown?", asked in exactly one place.
 *
 * WHY IT IS ITS OWN MODULE IN A SHARED PACKAGE. The predicate has three callers
 * that live in different layers: the file browser row (which double-click
 * behaviour to take), the row's context menu (whether to offer Preview) and the
 * viewer itself (whether a relative link is something it can open in place). A
 * copy per caller is how the three drift, and the failure is invisible — the
 * menu offers Preview on a file the viewer then refuses, or a double-click
 * opens the OS editor for a `.markdown` the menu happily previews. There is one
 * definition and the extension list is here.
 *
 * The list is the four extensions GitHub, VS Code and the CommonMark tooling
 * all agree on. `.mdx` is deliberately absent: MDX is JSX, and this renderer
 * would show its imports and components as prose.
 */

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd'];

/**
 * Does this name or path denote a markdown document?
 *
 * Takes a bare file name or a path with either separator — callers hold `rel`
 * strings, link hrefs and plain entry names, and none of them should have to
 * split the basename off first. Case-insensitive, because `README.MD` is a file
 * people really have. A name that is nothing but an extension (`.md`) is NOT
 * markdown: that is a dotfile whose whole name is the suffix, the same
 * distinction `copySiblingName` draws in fsScope.ts.
 */
export function isMarkdownFile(nameOrPath: string): boolean {
  if (!nameOrPath) return false;
  const base = nameOrPath.split(/[/\\]/).pop() ?? '';
  const lower = base.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.length > ext.length && lower.endsWith(ext));
}
