/**
 * gitStatusTint.ts — what a changed row looks like.
 *
 * The classes are here rather than in the row's JSX for the reason this
 * directory keeps giving: jsdom has no layout and no computed styles, so a class
 * chosen inside a template is a choice no test can reach. It is also the kind of
 * rule that erodes — one more state, one more inline ternary — until the tree
 * has five colours and nobody can say what the fourth one means.
 *
 * WHY THESE COLOURS. They are the app's existing semantic tokens, not new ones:
 * a file browser is not the place to introduce a palette. The mapping follows
 * what an editor's tree has trained people to expect, which is a real constraint
 * — a reader who has used VS Code already believes green means new and red means
 * gone, and disagreeing with that costs more than it could possibly buy.
 *
 * `modified` deliberately reuses the brand accent rather than a fifth hue: it is
 * by far the most common state, and a tree where most rows are shouting is a
 * tree where none of them are.
 */

import type { FileChangeState } from './gitStatusTypes';

/**
 * The text class for a row in this state.
 *
 * Returns the ordinary class for `null` — an unchanged file is the baseline, and
 * having one function answer for both cases is what stops the row's markup
 * growing a conditional that says the same thing.
 */
export function gitTintClass(state: FileChangeState | null | undefined): string {
  switch (state) {
    case 'conflicted':
      // The only state that is a PROBLEM rather than a fact, and the only one
      // given weight as well as colour: a file that needs resolving should not
      // read as one more edit.
      return 'text-red-11 font-semibold';
    case 'deleted':
      // Struck through as well as tinted. The row is still listed while the
      // deletion is unstaged, and "this is on its way out" is not something a
      // colour alone says.
      return 'text-red-11 line-through';
    case 'added':
      return 'text-green-11';
    case 'untracked':
      // Dimmer than `added`, because it is the weaker claim: git does not know
      // about this file yet.
      return 'text-green-11/70';
    case 'modified':
      return 'text-brand';
    case 'touched':
      // A DIFFERENT COLOUR FROM `modified`, on purpose, even though a reader
      // might call both "changed". They are not the same claim: `modified`
      // means "differs from the commit you made", and this means only "written
      // since you opened the project". Wearing the same colour would let a
      // project without git look like one with a clean baseline behind it.
      return 'text-amber-11';
    default:
      return 'text-foreground/90';
  }
}

/**
 * The hover-text explanation, as an i18n KEY rather than a sentence.
 *
 * A colour is not self-describing — `text-brand` on a filename says "something",
 * and the reader has no way to find out what. The key is resolved by the
 * component so the strings stay in the dictionaries where the both-locales test
 * can see them.
 */
export function gitTintTitleKey(state: FileChangeState | null | undefined): string | null {
  switch (state) {
    case 'conflicted':
      return 'fileBrowser.gitConflicted';
    case 'deleted':
      return 'fileBrowser.gitDeleted';
    case 'added':
      return 'fileBrowser.gitAdded';
    case 'untracked':
      return 'fileBrowser.gitUntracked';
    case 'modified':
      return 'fileBrowser.gitModified';
    case 'touched':
      return 'fileBrowser.touchedSinceOpen';
    default:
      return null;
  }
}
