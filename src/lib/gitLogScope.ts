/**
 * gitLogScope.ts — `git log` into commit rows, and commit rows into the lanes a
 * graph is drawn from. Pure, no IO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE LAYOUT IS COMPUTED HERE AND NOT IN THE COMPONENT
 *
 * The lane assignment is the one genuinely new piece of logic in the git panel,
 * and it is the kind that fails QUIETLY: a mis-assigned lane does not throw, it
 * draws a line from the wrong branch to the wrong commit, and the reader
 * believes it. It cannot be checked by looking at the screen either — a plausible
 * wrong graph and a correct one look equally plausible. So it is a pure function
 * over a list of hashes, pinned by tests with hand-checked expected lanes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MODEL
 *
 * A LANE is a column that holds one commit's worth of "what comes next going
 * down". Walking newest-to-oldest, each lane remembers the hash it is still
 * waiting to draw. A commit:
 *
 *   - takes the leftmost lane already waiting for it (or a fresh lane if none is
 *     — that is a branch tip);
 *   - hands its FIRST parent back to that same lane, so a straight line of
 *     history stays in one column;
 *   - puts every OTHER parent in a lane of its own — that is a merge fanning out
 *     downwards;
 *   - releases any other lanes that were also waiting for it — those are its
 *     other children, converging into this row.
 *
 * Edges are then read off the lane state BETWEEN two rows, which is what makes
 * the diagonals come out right in both directions: a line leaves the node's
 * column when the lane was opened by that node, and arrives at the next node's
 * column when the lane is waiting for that node.
 */

// ─────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────

/**
 * The `--format` this parser expects, and the reason for the separators.
 *
 * FIELDS ARE NUL-SEPARATED AND RECORDS END IN \x01 because a commit SUBJECT may
 * contain anything a person can type — tabs, pipes, the word "commit", a line
 * break in a badly-made commit. NUL and \x01 are the two bytes git will not put
 * in a message, so they are the only separators that cannot be forged by the
 * data. Splitting on newlines here would break the graph for any repository with
 * a multi-line subject in it.
 *
 * `%D` (ref names) is asked for WITHOUT `--decorate` deliberately: the format
 * placeholder gives the bare list, while the flag also rewrites the subject line.
 */
export const LOG_FORMAT = '%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%D%x00%s%x01';

export interface GitRef {
  name: string;
  kind: 'head' | 'branch' | 'remote' | 'tag';
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  /** ISO 8601, as git printed it. Formatting is the reader's problem, not this
   *  parser's — a relative date computed here would be stale by the time it is
   *  drawn. */
  date: string;
  subject: string;
  refs: GitRef[];
}

/**
 * Parse `%D` — e.g. `HEAD -> main, origin/main, tag: v1.2.0, grafted`.
 *
 * `HEAD -> main` IS TWO FACTS IN ONE TOKEN and they are kept apart: `main` is a
 * branch that would still exist if HEAD moved, and the arrow only says HEAD is
 * on it right now. Rendering the raw token would put the string "HEAD -> main"
 * in a branch label.
 */
export function parseRefs(decoration: string): GitRef[] {
  const out: GitRef[] = [];
  for (const raw of decoration.split(',')) {
    const token = raw.trim();
    if (!token) continue;

    if (token.startsWith('tag: ')) {
      out.push({ name: token.slice(5).trim(), kind: 'tag' });
      continue;
    }
    if (token.startsWith('HEAD -> ')) {
      const branch = token.slice(8).trim();
      out.push({ name: 'HEAD', kind: 'head' });
      if (branch) out.push({ name: branch, kind: 'branch' });
      continue;
    }
    if (token === 'HEAD') {
      out.push({ name: 'HEAD', kind: 'head' });
      continue;
    }
    // Notes and shallow markers are git talking about the READ, not about a ref
    // anybody can check out. Showing them as branches would offer a checkout
    // that cannot work.
    if (token === 'grafted' || token === 'replaced' || token.startsWith('refs/notes/')) {
      continue;
    }
    out.push({ name: token, kind: token.includes('/') ? 'remote' : 'branch' });
  }
  return out;
}

export function parseLog(stdout: string): GitCommit[] {
  const out: GitCommit[] = [];

  for (const record of stdout.split('\x01')) {
    // git separates records with \x01 and the shell hands back a trailing
    // newline before the next one; neither is part of a field.
    const trimmed = record.replace(/^\n+/, '');
    if (!trimmed.trim()) continue;

    const f = trimmed.split('\0');
    if (f.length < 8) continue;

    const [hash, shortHash, parents, author, authorEmail, date, decoration, subject] = f;
    if (!hash) continue;

    out.push({
      hash,
      shortHash: shortHash ?? hash.slice(0, 7),
      parents: (parents ?? '').split(' ').filter(Boolean),
      author: author ?? '',
      authorEmail: authorEmail ?? '',
      date: date ?? '',
      subject: subject ?? '',
      refs: parseRefs(decoration ?? ''),
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────

/** One line segment in the band between a row and the row below it. */
export interface GraphEdge {
  /** Column where the line sits at the TOP of the band. */
  fromLane: number;
  /** Column where it sits at the BOTTOM. Differs from `fromLane` exactly at a
   *  branch or a merge, which is what makes the diagonal. */
  toLane: number;
  /** Stable per branch line, so a colour survives the whole descent. */
  colour: number;
}

export interface GraphRow {
  commit: GitCommit;
  /** Column of this commit's node. */
  lane: number;
  colour: number;
  /** Segments drawn between this row and the next. Empty on the last row. */
  edges: GraphEdge[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Widest point, so the caller can size the gutter once instead of measuring. */
  laneCount: number;
}

/** A lane that is currently waiting for a commit. */
interface Lane {
  /** The hash this column will draw next, going down. */
  waitingFor: string;
  colour: number;
}

/**
 * Assign a lane and a colour to every commit, and work out the lines between
 * them.
 *
 * `commits` MUST be in the order git printed them with `--topo-order` — parents
 * strictly after children. The algorithm never looks ahead, so an out-of-order
 * list does not fail loudly; it draws a lane that waits for a commit already
 * passed, and that lane simply never closes.
 */
export function layoutGraph(commits: GitCommit[]): GraphLayout {
  const lanes: (Lane | null)[] = [];
  const rows: GraphRow[] = [];
  let laneCount = 0;
  let nextColour = 0;

  /** Put a lane in the leftmost free column, so the graph stays narrow instead
   *  of growing a new column for every branch ever seen. */
  const openLane = (lane: Lane): number => {
    const free = lanes.indexOf(null);
    if (free !== -1) {
      lanes[free] = lane;
      return free;
    }
    lanes.push(lane);
    return lanes.length - 1;
  };

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i]!;

    // 1. WHICH COLUMN IS THIS COMMIT IN? The leftmost lane already waiting for
    //    it. Leftmost rather than any, so that when several children converge
    //    the line settles into the oldest column rather than a random one.
    let lane = lanes.findIndex((l) => l?.waitingFor === commit.hash);
    let colour: number;

    if (lane === -1) {
      // Nothing was waiting: this is a tip — a branch head, or the newest commit.
      colour = nextColour++;
      lane = openLane({ waitingFor: commit.hash, colour });
    } else {
      colour = lanes[lane]!.colour;
    }

    // 2. CLOSE THE OTHER LANES WAITING FOR IT. Those are this commit's other
    //    children; their lines end here. Done BEFORE parents are placed so the
    //    columns they free can be reused by this commit's own parents, which is
    //    what keeps a merge from widening the graph permanently.
    for (let l = 0; l < lanes.length; l++) {
      if (l !== lane && lanes[l]?.waitingFor === commit.hash) lanes[l] = null;
    }

    // 3. HAND THE PARENTS DOWN. The first parent keeps this column — that is
    //    what makes mainline history a straight vertical line. Every other
    //    parent is a merged-in branch and gets its own column, unless some lane
    //    is already waiting for it, in which case the two are the same line.
    const opened = new Set<number>();
    if (commit.parents.length === 0) {
      // A root commit. Nothing continues below it.
      lanes[lane] = null;
    } else {
      lanes[lane] = { waitingFor: commit.parents[0]!, colour };
      for (let p = 1; p < commit.parents.length; p++) {
        const parent = commit.parents[p]!;
        const existing = lanes.findIndex((l) => l?.waitingFor === parent);
        if (existing !== -1) continue;
        opened.add(openLane({ waitingFor: parent, colour: nextColour++ }));
      }
    }

    // 3b. TWO LANES WAITING FOR THE SAME COMMIT ARE ONE LINE. It happens
    //     whenever two branches sit on the same ancestor — a merge's second
    //     parent and a stale branch off the same commit, say. Left alone, both
    //     columns run all the way down to that ancestor as parallel vertical
    //     lines, which reads as two branches where there is one, and makes the
    //     graph a column wider than git's own `--graph` draws it.
    //
    //     So the duplicates collapse into the leftmost of them, here, and the
    //     band below carries the diagonal that shows them joining.
    const collapsed: { from: number; to: number; colour: number }[] = [];
    const firstHolder = new Map<string, number>();
    for (let l = 0; l < lanes.length; l++) {
      const held = lanes[l];
      if (!held) continue;
      const kept = firstHolder.get(held.waitingFor);
      if (kept === undefined) {
        firstHolder.set(held.waitingFor, l);
        continue;
      }
      collapsed.push({ from: l, to: kept, colour: held.colour });
      lanes[l] = null;
    }

    // Trailing empty columns would make the gutter wider than the graph.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    laneCount = Math.max(laneCount, lanes.length, lane + 1);

    // 4. THE BAND BELOW THIS ROW. One segment per still-open lane.
    //
    //    A segment leaves this row at the NODE'S column when this commit opened
    //    the lane (a branch fanning out) and at its own column otherwise; it
    //    arrives at the next row at the NEXT NODE'S column when it is waiting
    //    for that commit (a line landing on it) and at its own column otherwise.
    //    Those two rules are the whole of the diagonal drawing.
    const next = commits[i + 1];
    const edges: GraphEdge[] = [];
    if (next) {
      // The lane the next row will occupy, decided by the same leftmost rule as
      // step 1 so the arrival column matches where the node will actually be.
      let nextLane = lanes.findIndex((l) => l?.waitingFor === next.hash);
      if (nextLane === -1) {
        const free = lanes.indexOf(null);
        nextLane = free !== -1 ? free : lanes.length;
      }

      for (let l = 0; l < lanes.length; l++) {
        const held = lanes[l];
        if (!held) continue;
        // The first parent stays in the node's own column, so it is drawn from
        // the node too — `opened` holds only the extra parents.
        const fromLane = opened.has(l) || l === lane ? lane : l;
        const toLane = held.waitingFor === next.hash ? nextLane : l;
        edges.push({ fromLane, toLane, colour: held.colour });
      }

      // The lines that just merged into another column. They arrive wherever
      // the lane they joined is drawn on the next row, so a collapse landing on
      // the next node follows it rather than stopping beside it.
      for (const c of collapsed) {
        const kept = lanes[c.to];
        const toLane = kept && kept.waitingFor === next.hash ? nextLane : c.to;
        edges.push({
          fromLane: opened.has(c.from) || c.from === lane ? lane : c.from,
          toLane,
          colour: c.colour,
        });
      }
      laneCount = Math.max(laneCount, nextLane + 1);
    }

    rows.push({ commit, lane, colour, edges });
  }

  return { rows, laneCount };
}
