/**
 * gitLogScope.test.ts — the lane assignment, pinned against graphs drawn by hand.
 *
 * The expected lanes below were worked out on paper from the parent lists, not
 * read off the implementation. That is the only way this test is worth having:
 * a graph regenerated from the code it is testing would agree with any bug.
 */
import { describe, expect, it } from 'vitest';
import { LOG_FORMAT, layoutGraph, parseLog, parseRefs, type GitCommit } from './gitLogScope';

/** Build a log record the way the format string does. */
function rec(
  hash: string,
  parents: string,
  opts: { subject?: string; refs?: string; author?: string } = {},
) {
  const fields = [
    hash,
    hash.slice(0, 7),
    parents,
    opts.author ?? 'Ada',
    'ada@example.com',
    '2026-09-01T10:00:00+09:00',
    opts.refs ?? '',
    opts.subject ?? `subject ${hash}`,
  ];
  return `${fields.join('\0')}\x01`;
}

/** A commit for the layout tests, where only hash and parents matter. */
function c(hash: string, ...parents: string[]): GitCommit {
  return {
    hash,
    shortHash: hash,
    parents,
    author: 'Ada',
    authorEmail: 'ada@example.com',
    date: '2026-09-01T10:00:00+09:00',
    subject: hash,
    refs: [],
  };
}

describe('the format string', () => {
  it('separates on bytes a commit message cannot contain', () => {
    // The whole parser rests on this. If the format ever grows a separator a
    // person can type, a commit subject can forge a field boundary.
    expect(LOG_FORMAT).toContain('%x00');
    expect(LOG_FORMAT).toContain('%x01');
    expect(LOG_FORMAT).not.toContain('|');
  });
});

describe('reading a commit', () => {
  it('splits the fields', () => {
    const [commit] = parseLog(rec('aaaa111', '', { subject: 'first' }));
    expect(commit).toMatchObject({
      hash: 'aaaa111',
      parents: [],
      author: 'Ada',
      subject: 'first',
      date: '2026-09-01T10:00:00+09:00',
    });
  });

  it('reads a merge as two parents', () => {
    const [commit] = parseLog(rec('m', 'p1 p2'));
    expect(commit!.parents).toEqual(['p1', 'p2']);
  });

  it('survives a subject containing the things a naive split would break on', () => {
    const [commit] = parseLog(rec('a', '', { subject: 'fix: a|b\ttab, and, commas' }));
    expect(commit!.subject).toBe('fix: a|b\ttab, and, commas');
  });

  it('reads many records, ignoring the newline git puts between them', () => {
    const commits = parseLog(`${rec('a', 'b')}\n${rec('b', '')}\n`);
    expect(commits.map((x) => x.hash)).toEqual(['a', 'b']);
  });

  it('drops a truncated record rather than inventing empty fields', () => {
    expect(parseLog('short\0record\x01')).toEqual([]);
    expect(parseLog('')).toEqual([]);
  });
});

describe('reading the decorations', () => {
  it('splits HEAD -> main into the two facts it is', () => {
    expect(parseRefs('HEAD -> main')).toEqual([
      { name: 'HEAD', kind: 'head' },
      { name: 'main', kind: 'branch' },
    ]);
  });

  it('tells a tag from a branch from a remote', () => {
    expect(parseRefs('tag: v1.2.0, origin/main, feature-x')).toEqual([
      { name: 'v1.2.0', kind: 'tag' },
      { name: 'origin/main', kind: 'remote' },
      { name: 'feature-x', kind: 'branch' },
    ]);
  });

  it('ignores markers that are not refs anyone can check out', () => {
    expect(parseRefs('grafted')).toEqual([]);
    expect(parseRefs('')).toEqual([]);
  });
});

describe('laying out a straight history', () => {
  it('keeps one column', () => {
    // a → b → c, nothing branching.
    const { rows, laneCount } = layoutGraph([c('a', 'b'), c('b', 'c'), c('c')]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(laneCount).toBe(1);
    // Each band holds exactly one straight segment, except the last row.
    expect(rows[0]!.edges).toEqual([{ fromLane: 0, toLane: 0, colour: 0 }]);
    expect(rows[2]!.edges).toEqual([]);
  });

  it('gives every commit on one line the same colour', () => {
    const { rows } = layoutGraph([c('a', 'b'), c('b', 'c'), c('c')]);
    expect(new Set(rows.map((r) => r.colour)).size).toBe(1);
  });
});

describe('laying out a merge', () => {
  /**
   *  m      merge, parents a and b
   *  |\
   *  a |    on mainline
   *  | b    the merged-in branch
   *  |/
   *  base
   */
  const history = [c('m', 'a', 'b'), c('a', 'base'), c('b', 'base'), c('base')];

  it('puts the merge and its first parent in the same column', () => {
    const { rows } = layoutGraph(history);
    expect(rows[0]!.lane).toBe(0); // m
    expect(rows[1]!.lane).toBe(0); // a — first parent keeps the column
    expect(rows[2]!.lane).toBe(1); // b — the second parent got its own
    expect(rows[3]!.lane).toBe(0); // base — leftmost lane waiting for it
  });

  it('draws the second parent leaving the merge node, not its own column', () => {
    const { rows } = layoutGraph(history);
    // Below `m` two lanes are open: 0 waiting for a, 1 waiting for b. Both lines
    // start AT the merge node in column 0 — that is the fan-out.
    const merge = rows[0]!.edges;
    expect(merge).toHaveLength(2);
    expect(merge[0]).toEqual({ fromLane: 0, toLane: 0, colour: 0 });
    expect(merge[1]).toMatchObject({ fromLane: 0, toLane: 1 });
  });

  it('draws the branch converging back onto the commit below it', () => {
    const { rows } = layoutGraph(history);
    // Band under `b` (row 2): lane 1 held b's parent `base`, which is the next
    // row's commit, so the line lands in base's column — 0, not 1.
    const under = rows[2]!.edges;
    expect(under.some((e) => e.fromLane === 1 && e.toLane === 0)).toBe(true);
  });

  it('closes the branch column once both children have been drawn', () => {
    // After base, nothing is left open, so the graph is one lane wide again.
    const { rows } = layoutGraph(history);
    expect(rows[3]!.edges).toEqual([]);
  });

  it('gives the merged-in branch a different colour from mainline', () => {
    const { rows } = layoutGraph(history);
    expect(rows[2]!.colour).not.toBe(rows[1]!.colour);
  });
});

describe('laying out two tips', () => {
  it('opens a second column for a branch nothing points at yet', () => {
    // Two unrelated heads in one log — what `--all` gives for a checked-out
    // branch plus a stale one.
    const { rows, laneCount } = layoutGraph([c('x', 'base'), c('y', 'base'), c('base')]);
    expect(rows[0]!.lane).toBe(0);
    expect(rows[1]!.lane).toBe(1);
    expect(rows[2]!.lane).toBe(0);
    expect(laneCount).toBe(2);
  });

  it('reuses a freed column rather than growing the graph forever', () => {
    // x and y both end at base; the next tip should land back in column 1, not 2.
    const { laneCount } = layoutGraph([
      c('x', 'base'),
      c('y', 'base'),
      c('base', 'older'),
      c('older'),
    ]);
    expect(laneCount).toBe(2);
  });
});

describe('two branches sitting on the same ancestor', () => {
  /**
   * The layout below is `git log --graph --topo-order --all` over a repository
   * built for this test: a branch `stale` off `m1`, a `side` branch merged back,
   * and a `feat` branch merged before it. git draws it in THREE columns:
   *
   *   * t1            lane 0   (stale)
   *   | *   merge     lane 1
   *   | |\
   *   | | * s1        lane 2
   *   | |/
   *   |/|
   *   | * m2          lane 1
   *   |/
   *   * m1            lane 0
   *
   * The trap is `stale` and `s1` both waiting for `m1`. Left as two lanes they
   * descend as parallel verticals and the graph is four columns wide, showing a
   * branch that does not exist.
   */
  const history = [
    c('t1', 'm1'),
    c('merge', 'm2', 's1'),
    c('s1', 'm1'),
    c('m2', 'm1'),
    c('m1', 'base'),
    c('base'),
  ];

  it('puts every commit in the column git puts it in', () => {
    const { rows, laneCount } = layoutGraph(history);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 2, 1, 0, 0]);
    expect(laneCount).toBe(3);
  });

  it('collapses the duplicate lane instead of running it down in parallel', () => {
    const { rows } = layoutGraph(history);
    // Below `s1` (row 2) its lane joins the one already waiting for m1 rather
    // than staying in column 2.
    expect(rows[2]!.edges.some((e) => e.fromLane === 2 && e.toLane < 2)).toBe(true);
    // And no lane below that row is still holding column 2.
    expect(rows[3]!.edges.every((e) => e.fromLane < 2)).toBe(true);
  });
});

/**
 * THE INVARIANT THAT MATTERS MORE THAN ANY PARTICULAR COLUMN.
 *
 * A lane number can be argued about — git's own `--graph` packs columns
 * differently from this layout, shifting existing lanes rightwards so a merge's
 * second parent sits next to the merge, where this keeps lanes where they are
 * and appends. Both draw the same history; stable columns are the better choice
 * in a panel you scroll, because a line that jogs sideways when an unrelated
 * branch appears reads as history that did not happen.
 *
 * What CANNOT be argued about is whether every parent is actually joined to its
 * child. A graph that draws the right number of lines in the wrong places is the
 * failure this whole module exists to prevent, and it is invisible on screen.
 */
function everyParentIsConnected(commits: GitCommit[]): string[] {
  const { rows } = layoutGraph(commits);
  const rowOf = new Map(rows.map((r, i) => [r.commit.hash, i]));
  const broken: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    for (const parent of rows[i]!.commit.parents) {
      const j = rowOf.get(parent);
      // A parent past the end of the window has nothing to connect to.
      if (j === undefined) continue;

      // Walk the bands from the child down to the parent, following edges that
      // leave the lane we are currently in. Several may leave one lane (that is
      // what a merge is), so this is a search rather than a single path.
      let reachable = new Set<number>([rows[i]!.lane]);
      for (let band = i; band < j; band++) {
        const next = new Set<number>();
        for (const e of rows[band]!.edges) {
          if (reachable.has(e.fromLane)) next.add(e.toLane);
        }
        reachable = next;
        if (reachable.size === 0) break;
      }
      if (!reachable.has(rows[j]!.lane)) {
        broken.push(`${rows[i]!.commit.hash} → ${parent}`);
      }
    }
  }
  return broken;
}

describe('every parent is joined to its child', () => {
  it('holds for a merge', () => {
    expect(
      everyParentIsConnected([c('m', 'a', 'b'), c('a', 'base'), c('b', 'base'), c('base')]),
    ).toEqual([]);
  });

  it('holds where two branches share an ancestor and one lane collapses', () => {
    expect(
      everyParentIsConnected([
        c('t1', 'm1'),
        c('merge', 'm2', 's1'),
        c('s1', 'm1'),
        c('m2', 'm1'),
        c('m1', 'base'),
        c('base'),
      ]),
    ).toEqual([]);
  });

  it('holds for the shape that first exposed the collapse — two merges, three tips', () => {
    // Taken from a real repository built for this: `feat` merged, then `side`
    // merged, plus a `stale` branch never merged at all. Every one of those
    // lines ends at the same ancestor.
    expect(
      everyParentIsConnected([
        c('head', 'mergeSide'),
        c('mergeSide', 'm3', 's1'),
        c('s1', 'm1'),
        c('m3', 'mergeFeat'),
        c('mergeFeat', 'm2', 'f2'),
        c('f2', 'f1'),
        c('f1', 'm1'),
        c('m2', 'm1'),
        c('stale', 'm1'),
        c('m1', 'base'),
        c('base'),
      ]),
    ).toEqual([]);
  });

  it('holds for a three-parent octopus merge', () => {
    expect(
      everyParentIsConnected([
        c('octo', 'a', 'b', 'cc'),
        c('a', 'base'),
        c('b', 'base'),
        c('cc', 'base'),
        c('base'),
      ]),
    ).toEqual([]);
  });
});

describe('the edges of the log window', () => {
  it('ends a lane whose parent was cut off by the limit', () => {
    // `d` names a parent that is not in the window. Nothing below it to draw.
    const { rows } = layoutGraph([c('d', 'not-loaded')]);
    expect(rows[0]!.edges).toEqual([]);
    expect(rows[0]!.lane).toBe(0);
  });

  it('handles an empty log', () => {
    expect(layoutGraph([])).toEqual({ rows: [], laneCount: 0 });
  });

  it('handles a repository with exactly one commit', () => {
    const { rows, laneCount } = layoutGraph([c('only')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lane).toBe(0);
    expect(laneCount).toBe(1);
  });

  it('never reports fewer lanes than a row actually uses', () => {
    const { rows, laneCount } = layoutGraph([
      c('m', 'a', 'b', 'cc'),
      c('a', 'base'),
      c('b', 'base'),
      c('cc', 'base'),
      c('base'),
    ]);
    for (const row of rows) {
      expect(row.lane).toBeLessThan(laneCount);
      for (const e of row.edges) {
        expect(e.fromLane).toBeLessThan(laneCount);
        expect(e.toLane).toBeLessThan(laneCount);
      }
    }
  });
});
