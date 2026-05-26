#!/usr/bin/env node
/**
 * cock affected — CLI wrapper around /api/projectGraph/affected.
 *
 * Usage:
 *   cock affected src/a.ts src/b.ts                Pass files as positional args
 *   git diff --name-only | cock affected --stdin   Read files from stdin
 *   cock affected src/auth.ts --filter "**\/*.e2e.ts"
 *   cock affected --stdin --as-jest                Emit a `jest <paths>` command
 *   cock affected --stdin --json                   Emit raw JSON instead of paths
 *
 * Exit codes:
 *   0  one or more test files printed
 *   1  no affected tests (empty output)
 *   2  argument / usage error
 *   3  Cockpit server not reachable on COCKPIT_PORT (default 3457)
 *
 * The server must already be running. The CLI is a thin HTTP shim so it
 * shares the live CodeIndex / analytics cache (no per-invocation parse).
 */
import { argv, cwd, exit, stderr, stdin, stdout, env } from 'node:process';

const PORT = env.COCKPIT_PORT || '3457';
const HOST = env.COCKPIT_HOST || 'localhost';
const BASE = `http://${HOST}:${PORT}`;

// ----------------------------------------------------------------------
// Arg parsing — tiny, no deps.
// ----------------------------------------------------------------------
let useStdin = false;
let asJest = false;
let asJson = false;
let depth = 10;
let filter;
let includeAll = false;
let showHelp = false;
const files = [];

const args = argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--stdin') useStdin = true;
  else if (a === '--as-jest') asJest = true;
  else if (a === '--json') asJson = true;
  else if (a === '--include-all') includeAll = true;
  else if (a === '-h' || a === '--help') showHelp = true;
  else if (a === '--depth') {
    depth = parseInt(args[++i], 10);
    if (!Number.isFinite(depth)) {
      stderr.write(`affected: --depth requires a number\n`);
      exit(2);
    }
  } else if (a === '--filter') {
    filter = args[++i];
    if (!filter) {
      stderr.write(`affected: --filter requires a value\n`);
      exit(2);
    }
  } else if (a.startsWith('-')) {
    stderr.write(`affected: unknown flag "${a}"\n`);
    exit(2);
  } else {
    files.push(a);
  }
}

if (showHelp) {
  stdout.write(`Usage:
  cock affected <files…>                 Find test files affected by these source files
  git diff --name-only | cock affected --stdin

Options:
  --stdin                Read file list from stdin (one path per line)
  --filter <glob>        Restrict test paths matching this glob (e.g. "**/*.e2e.ts")
  --depth <n>            Max BFS depth (1-20, default 10)
  --include-all          Also report non-test files in the affected set (JSON only)
  --as-jest              Emit a single \`jest <paths>\` command
  --json                 Emit raw JSON response
  -h, --help             Show this help

Output is one test path per line, alphabetically sorted, ready to pipe to
xargs (\`cock affected --stdin | xargs jest\`). Exits 1 if no tests are
affected, 3 if the Cockpit server is not running on COCKPIT_PORT (${PORT}).
`);
  exit(0);
}

// ----------------------------------------------------------------------
// Collect stdin lines if requested.
// ----------------------------------------------------------------------
async function readStdin() {
  let buf = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) buf += chunk;
  return buf
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

if (useStdin) {
  const lines = await readStdin();
  files.push(...lines);
}

if (files.length === 0) {
  stderr.write('affected: no files provided (pass file args or use --stdin)\n');
  exit(2);
}

// ----------------------------------------------------------------------
// Call POST /api/projectGraph/affected.
// ----------------------------------------------------------------------
const payload = {
  cwd: cwd(),
  files,
  depth,
  filter,
  includeAll,
  format: asJson ? 'json' : 'plain',
};

let resp;
try {
  resp = await fetch(`${BASE}/api/projectGraph/affected`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    // No fetch timeout — large monorepos may take a few seconds on
    // first request while the index warms up.
  });
} catch (err) {
  stderr.write(
    `affected: cannot reach Cockpit at ${BASE}\n` +
      `        (${err?.code ?? err?.name ?? 'fetch failed'})\n` +
      `        Start it with: cock\n`,
  );
  exit(3);
}

if (!resp.ok) {
  const text = await resp.text();
  stderr.write(`affected: server returned ${resp.status}\n${text}\n`);
  exit(2);
}

// ----------------------------------------------------------------------
// Render.
// ----------------------------------------------------------------------
if (asJson) {
  const json = await resp.json();
  stdout.write(JSON.stringify(json, null, 2) + '\n');
  exit(json?.testFiles?.length > 0 ? 0 : 1);
}

const unresolvedHdr = parseInt(resp.headers.get('x-unresolved-count') ?? '0', 10) || 0;
const truncated = resp.headers.get('x-truncated') === 'true';
const text = await resp.text();
const paths = text.split('\n').map((l) => l.trim()).filter(Boolean);

if (unresolvedHdr > 0) {
  stderr.write(
    `affected: ${unresolvedHdr} input file(s) not found in CodeIndex (deleted, generated, or unsupported language)\n`,
  );
}
if (truncated) {
  stderr.write(
    `affected: BFS hit node cap — results may miss deeper tests (try smaller input set or --depth less)\n`,
  );
}

if (asJest) {
  if (paths.length === 0) {
    stderr.write('affected: no test files — nothing to run\n');
    exit(1);
  }
  stdout.write(`jest ${paths.map((p) => JSON.stringify(p)).join(' ')}\n`);
  exit(0);
}

if (paths.length === 0) {
  // Plain mode: emit nothing on stdout; exit 1 to signal "no tests".
  exit(1);
}

stdout.write(paths.join('\n') + '\n');
exit(0);

// This module is imported by cock.mjs which awaits `done`.
export const done = Promise.resolve();
