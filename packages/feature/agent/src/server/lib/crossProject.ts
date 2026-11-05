// packages/feature/agent/src/server/lib/crossProject.ts
//
// LOOKING INTO ANOTHER PROJECT (specs/cross-project-context.md).
//
// "server에서 바꾼 것에 맞춰 client도 고쳐야 하나?" asked in the proposal tab.
// naby may now read the server and client folders — files and git, read-only —
// through `naby_read_project`, and ask a tab of those projects through the
// widened cross-session tools. This module is the shell half of both:
//
//   1. THE ONE DECISION (R5). `crossProjectStanding(store, fromCwd, toCwd,
//      sessionId)` answers for both features with TWO things: the RELATION
//      (the runtime's pure group rule over `sidebar.projectGroups`, read
//      through the sidebar's own normalizer — used for the listing and the
//      card's wording only) and the ACCESS (a permanent "always allow" pair,
//      this session's decline, or needs-approval). The same group is never an
//      access grant (0.2.0).
//   2. THE CARD (R17–R19). Every content access to another project — same
//      group included — asks, unless the user chose "always allow" for this
//      (from, to) pair. The guard raises the approval ITSELF, after the gate has
//      let the call through — `naby_participant_draft`'s pattern — so neither a
//      policy rule nor the allow-all baseline answers for it. Three answers:
//      "allow once" passes the call(s) waiting on that card and stores nothing;
//      "always allow" writes the directed pair to app.db
//      (`sessions.crossProject.approvals`, R18) and survives a restart; "decline"
//      is kept in memory per session — gone on restart, dropped once the tab
//      (= the session) is gone. A timeout or a stopped turn is not an answer and
//      is not remembered; that call is simply refused.
//   3. THE READS (R11–R13). The runtime's fs read executors pointed at the
//      target folder, behind a real-path check (a symlink out of the folder is
//      refused), and git as a fixed argv with no shell. Every result starts
//      with the origin header and is fenced as someone else's text (R21, R22).
//
// THE PURE HALF — the group rule, schemas, parser, git argv, header, fence — is
// the runtime's (`src/runtime/cross-project.ts`).

import { execFile } from 'node:child_process';
import {
  orderProjects,
  parseStoredGroups,
  parseStoredProjectOrder,
  projectNumbers,
  PROJECT_GROUPS_SETTING_KEY,
  PROJECT_ORDER_SETTING_KEY,
  type ProjectGroup,
  type ProjectNumber,
} from '@cockpit/shared-utils';
import {
  addCrossProjectApproval,
  buildGitArgs,
  checkRealPathInside,
  clipGitOutput,
  CROSS_PROJECT_APPROVALS_KEY,
  crossProjectAccessAllows,
  crossProjectAccessOf,
  groupOfProject,
  hasCrossProjectApproval,
  parseCrossProjectApprovals,
  removeCrossProjectApproval,
  serializeCrossProjectApprovals,
  CROSS_PROJECT_GIT_OUTPUT_MAX_BYTES,
  formatCrossProjectResult,
  LIST_PROJECTS_TOOL_SCHEMA,
  logActivity,
  makeGlob,
  makeGrep,
  makeListDir,
  makeReadFile,
  parseReadProjectInput,
  READ_PROJECT_TOOL_SCHEMA,
  resolveCrossProjectRelation,
  resolveProjectRef,
} from '../../../../../../../dist/naby-runtime.mjs';
import type {
  CrossProjectAccess,
  CrossProjectApprovalPair,
  CrossProjectGroup,
  CrossProjectRelation,
  Executor,
  ProjectRefCandidate,
  GateDecision,
  ReadProjectInput,
  Store,
  ToolOutput,
  ToolSchema,
} from '../../../../../../../dist/naby-runtime.mjs';
import { CROSS_PROJECT_ACCESS_TOOL, registerApproval, unregisterApproval, type ApprovalExtras } from './approvalRegistry';
import { projectDisplayNames } from './projectDisplayName';

/** R6: the switch. Default ON; `'false'` takes the two tools away and puts the
 *  cross-session tools back to this project only. */
export const CROSS_PROJECT_ENABLED_KEY = 'sessions.crossProject.enabled';

/** `approval_request.source` for the access card — the client draws its own card. */
export const CROSS_PROJECT_SOURCE = 'cross_project';

export function readCrossProjectEnabled(store: Pick<Store, 'getSetting'>): boolean {
  return (store.getSetting(CROSS_PROJECT_ENABLED_KEY) ?? 'true') !== 'false';
}

export function writeCrossProjectEnabled(store: Pick<Store, 'setSetting'>, enabled: boolean): void {
  store.setSetting(CROSS_PROJECT_ENABLED_KEY, enabled ? 'true' : 'false');
}

export type CrossProjectStore = Pick<Store, 'listProjects' | 'getSetting' | 'getSession'>;
/** What writing a permanent approval needs on top (the guard, the settings API). */
export type CrossProjectWritableStore = CrossProjectStore & Pick<Store, 'setSetting'>;

// ---------------------------------------------------------------------------
// Per-session declines and permanent approvals (R18)
// ---------------------------------------------------------------------------

const DECLINES_KEY = Symbol.for('naby.crossProject.declines');

/** sessionId → the target cwds the user declined in that session. Pinned on
 *  `globalThis` like the approval registry: the turn and the resolving request
 *  can be different module realms. Only a DECLINE lives here — "allow once"
 *  stores nothing and "always allow" is in app.db. */
function declines(): Map<string, Set<string>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Set<string>> | undefined>;
  let m = g[DECLINES_KEY];
  if (!m) {
    m = new Map();
    g[DECLINES_KEY] = m;
  }
  return m;
}

/** Drop the declines of sessions that no longer exist — a closed tab deletes its
 *  session (R18: "탭을 닫으면 지운다"). Lazy: asked on every decision read. */
function pruneClosed(store: Pick<Store, 'getSession'>): void {
  for (const sessionId of declines().keys()) {
    if (store.getSession(sessionId) === undefined) declines().delete(sessionId);
  }
}

export function crossProjectDeclined(sessionId: string, cwd: string): boolean {
  return declines().get(sessionId)?.has(cwd) ?? false;
}

export function recordCrossProjectDecline(sessionId: string, cwd: string): void {
  let m = declines().get(sessionId);
  if (!m) {
    m = new Set();
    declines().set(sessionId, m);
  }
  m.add(cwd);
}

/** Forget one session's declines (a closed tab, when the caller knows). */
export function forgetCrossProjectSession(sessionId: string): void {
  declines().delete(sessionId);
}

/** Tests only. */
export function resetCrossProjectDecisions(): void {
  declines().clear();
}

/** The permanent "always allow" pairs (R18), from app.db. */
export function readCrossProjectApprovals(store: Pick<Store, 'getSetting'>): CrossProjectApprovalPair[] {
  return parseCrossProjectApprovals(store.getSetting(CROSS_PROJECT_APPROVALS_KEY));
}

/** Record "always allow" for `from` → `to` (directed). Only the card's answer
 *  calls this — never a policy rule or a global default (R17). */
export function addCrossProjectApprovalPair(
  store: Pick<Store, 'getSetting' | 'setSetting'>,
  from: string,
  to: string,
  at: number = Date.now(),
): void {
  const next = addCrossProjectApproval(readCrossProjectApprovals(store), { from, to, at });
  store.setSetting(CROSS_PROJECT_APPROVALS_KEY, serializeCrossProjectApprovals(next));
}

/** R18a: delete one permanent pair. True when it was there. */
export function removeCrossProjectApprovalPair(
  store: Pick<Store, 'getSetting' | 'setSetting'>,
  from: string,
  to: string,
): boolean {
  const before = readCrossProjectApprovals(store);
  const next = removeCrossProjectApproval(before, from, to);
  if (next.length === before.length) return false;
  store.setSetting(CROSS_PROJECT_APPROVALS_KEY, serializeCrossProjectApprovals(next));
  return true;
}

/** R18a: the permanent pairs as the settings list draws them — display names,
 *  and whether each end is still in the sidebar list (a missing end is dimmed). */
export type CrossProjectApprovalRow = {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  fromListed: boolean;
  toListed: boolean;
  at?: number;
};

export function listCrossProjectApprovals(store: CrossProjectStore): CrossProjectApprovalRow[] {
  let listed = new Set<string>();
  try {
    listed = new Set(store.listProjects().map((p) => p.cwd));
  } catch {
    listed = new Set();
  }
  const nameOf = projectDisplayNames(store);
  return readCrossProjectApprovals(store).map((p) => ({
    from: p.from,
    to: p.to,
    fromName: (listed.has(p.from) && nameOf(p.from)) || basenameOf(p.from),
    toName: (listed.has(p.to) && nameOf(p.to)) || basenameOf(p.to),
    fromListed: listed.has(p.from),
    toListed: listed.has(p.to),
    ...(p.at !== undefined ? { at: p.at } : {}),
  }));
}

const basenameOf = (cwd: string): string => cwd.replace(/\/+$/, '').split('/').pop() || cwd;

// ---------------------------------------------------------------------------
// The decision (R1–R5)
// ---------------------------------------------------------------------------

/** The stored sidebar groups (ids and collapse flags included), through the
 *  sidebar's own normalizer (project-groups §3): members not in the project
 *  list dropped, a duplicated cwd kept in the first group, broken JSON read as
 *  no groups. */
function readStoredGroups(store: Pick<Store, 'getSetting' | 'listProjects'>): ProjectGroup[] {
  let known: string[] | undefined;
  try {
    known = store.listProjects().map((p) => p.cwd);
  } catch {
    known = undefined;
  }
  return parseStoredGroups(store.getSetting(PROJECT_GROUPS_SETTING_KEY), known);
}

/** The sidebar groups as the decision needs them. */
export function readProjectGroups(store: Pick<Store, 'getSetting' | 'listProjects'>): CrossProjectGroup[] {
  return readStoredGroups(store);
}

/**
 * The project list in the sidebar's order: the order the last list save
 * recorded (`sidebar.projectOrder`), projects added since appended. NOT the
 * table's own order — that is the last-opened stamp, which moves whenever a
 * project is opened or a turn runs, while the rows on screen stay put.
 */
export function readSidebarProjects<P extends { cwd: string }>(
  store: Pick<Store, 'getSetting'> & { listProjects(): P[] },
): ReadonlyArray<P> {
  let rows: P[] = [];
  try {
    rows = store.listProjects();
  } catch {
    rows = [];
  }
  return orderProjects(rows, parseStoredProjectOrder(store.getSetting(PROJECT_ORDER_SETTING_KEY)));
}

/**
 * The sidebar numbers (project-groups §9), by cwd — through the ONE
 * `projectNumbers` the sidebar draws with (R33), over the sidebar's own order.
 */
export function readProjectNumbers(store: Pick<Store, 'getSetting' | 'listProjects'>): Map<string, ProjectNumber> {
  return projectNumbers(readSidebarProjects(store), readStoredGroups(store));
}

/** Every listed project as `resolveProjectRef` takes it: display name, sidebar
 *  number and section (R7a, R7b) — this project included, so a bare "3" can be
 *  read in its section. */
export function projectRefCandidates(store: CrossProjectStore): ProjectRefCandidate[] {
  let rows: { cwd: string }[] = [];
  try {
    rows = store.listProjects();
  } catch {
    rows = [];
  }
  const nameOf = projectDisplayNames(store);
  const numbers = readProjectNumbers(store);
  return rows.map((p) => {
    const n = numbers.get(p.cwd);
    return {
      cwd: p.cwd,
      name: nameOf(p.cwd) || p.cwd,
      ...(n ? { number: n.number, section: n.groupName } : {}),
    };
  });
}

/** R7e: how a project is labelled by number — "RMS 3" in a group, "3" in the
 *  ungrouped area; undefined when it has no number. */
export function projectNumberLabel(n: ProjectNumber | undefined): string | undefined {
  if (!n) return undefined;
  return n.groupName ? `${n.groupName} ${n.number}` : String(n.number);
}

/** R5 — the relation (for listing and wording) and the access (the only thing
 *  that decides) for one target. */
export type CrossProjectStanding = {
  relation: CrossProjectRelation;
  access: CrossProjectAccess;
  /** The shared group's name when `relation` is `same-group` (the card names it). */
  group?: string;
};

/** R5 — THE one answer both features ask about `toCwd` from this session. */
export function crossProjectStanding(
  store: CrossProjectStore,
  fromCwd: string,
  toCwd: string,
  sessionId: string,
): CrossProjectStanding {
  let projects: { cwd: string }[] = [];
  try {
    projects = store.listProjects();
  } catch {
    projects = [];
  }
  const groups = readProjectGroups(store);
  const relation = resolveCrossProjectRelation({ projects, groups, fromCwd, toCwd });
  pruneClosed(store);
  // A permanent pair wins over a decline: once "always allow" exists no card
  // is ever shown for the pair, so a decline can only predate it.
  const decision = hasCrossProjectApproval(readCrossProjectApprovals(store), fromCwd, toCwd)
    ? 'approved'
    : crossProjectDeclined(sessionId, toCwd)
      ? 'denied'
      : undefined;
  const group = relation === 'same-group' ? groupOfProject(groups, fromCwd)?.name : undefined;
  return { relation, access: crossProjectAccessOf(relation, decision), ...(group ? { group } : {}) };
}

/** R5, the access half only. */
export function crossProjectAccess(
  store: CrossProjectStore,
  fromCwd: string,
  toCwd: string,
  sessionId: string,
): CrossProjectAccess {
  return crossProjectStanding(store, fromCwd, toCwd, sessionId).access;
}

export type CrossProjectEntry = {
  cwd: string;
  name: string;
  group?: string;
  /** The sidebar number inside its section (project-groups §9). */
  number?: number;
  relation: CrossProjectRelation;
  access: CrossProjectAccess;
};

/** Every project of the sidebar list but this one, with its access state, in
 *  the sidebar's display order (groups in order, then the ungrouped area). */
export function listCrossProjects(store: CrossProjectStore, fromCwd: string, sessionId: string): CrossProjectEntry[] {
  const rows = readSidebarProjects(store);
  const nameOf = projectDisplayNames(store);
  const groups = readStoredGroups(store);
  const numbers = projectNumbers(rows, groups);
  const sectionRank = (cwd: string): number => {
    const gid = numbers.get(cwd)?.groupId ?? null;
    const i = gid === null ? -1 : groups.findIndex((g) => g.id === gid);
    return i < 0 ? groups.length : i;
  };
  return rows
    .filter((p) => p.cwd !== fromCwd)
    .map((p) => {
      const group = groupOfProject(groups, p.cwd);
      const standing = crossProjectStanding(store, fromCwd, p.cwd, sessionId);
      const n = numbers.get(p.cwd);
      return {
        cwd: p.cwd,
        name: nameOf(p.cwd) || p.cwd,
        ...(group ? { group: group.name } : {}),
        ...(n ? { number: n.number } : {}),
        relation: standing.relation,
        access: standing.access,
      };
    })
    .sort((a, b) => sectionRank(a.cwd) - sectionRank(b.cwd) || (a.number ?? 0) - (b.number ?? 0));
}

// ---------------------------------------------------------------------------
// The guard: decide, ask when needed, log (R14, R17–R19, R25)
// ---------------------------------------------------------------------------

/** What a guarded call is about, for the card and the log. */
export type CrossProjectRequest = {
  feature: 'read' | 'send';
  /** The read op, or `send`. */
  op: string;
  /** The tool call that triggered it — the approval id is built from it. */
  toolCallId: string;
  /** `send`: the target tab's title, named on the card. */
  sessionTitle?: string;
  /** `send` with no open tab there: a new conversation will be opened in the
   *  target project for the request (R7d) — the card says so. */
  newSession?: boolean;
};

export type CrossProjectCheck =
  | { ok: true; verdict: CrossProjectAccess }
  | { ok: false; verdict: CrossProjectAccess; content: string };

export type CrossProjectGuard = {
  check(target: { cwd: string; name: string }, request: CrossProjectRequest): Promise<CrossProjectCheck>;
};

export type CrossProjectGuardDeps = {
  /** Writable: "always allow" stores its pair here (R18). */
  store: CrossProjectWritableStore;
  sessionId: string;
  /** This turn's project. */
  cwd: string;
  /** The turn's stream (`ctx.emit`). */
  emit: (event: Record<string, unknown>) => void;
  /** The turn's abort signal — a stopped turn declines. */
  signal: AbortSignal;
  /** How long the card waits (the tool approval TTL, R19). */
  ttlMs: number;
  now?: () => number;
  log?: (
    kind: 'cross_project_access' | 'approval_requested' | 'approval_resolved',
    payload: Record<string, unknown>,
  ) => void;
  /** Telegram, by the existing relay rule (R20). Read per ask. */
  escalate?: {
    enabled: () => boolean;
    send: (input: { approvalId: string; toolName: string; input: unknown }) => void;
    finish: (input: { approvalId: string; decision: 'allow' | 'deny'; reason?: string }) => void;
  };
};

type Answer = 'allow' | 'always' | 'deny' | 'timeout' | 'abort';

/** The card's payload (`approval_request.input`). `relation` and `group` pick
 *  the card's group line (R17): "같은 그룹 ‹RMS›의 프로젝트입니다." or "다른 그룹". */
export type CrossProjectApprovalInput = {
  project: string;
  cwd: string;
  kind: 'read' | 'send';
  sessionTitle?: string;
  /** R7d: the request opens a new conversation there. */
  newSession?: true;
  relation: 'same-group' | 'other-group';
  group?: string;
  /** R7e: the target's sidebar number, and its section's group name (absent in
   *  the ungrouped area) — the card shows "RMS 3번 ‹DT_RMS›". */
  number?: number;
  section?: string;
};

/** What a refused call tells the model. */
function refusalText(verdict: CrossProjectAccess | Answer, name: string, feature: 'read' | 'send'): string {
  const did = feature === 'read' ? 'Nothing was read' : 'Nothing was sent';
  switch (verdict) {
    case 'unknown-project':
      return `${did}: that folder is not a project in the sidebar list. Only listed projects can be reached.`;
    case 'denied':
    case 'deny':
      return `${did}: the user declined access to project "${name}" in this conversation. Do not ask again; tell the user if you need it.`;
    case 'timeout':
      return `${did}: the user did not answer the request to access project "${name}" in time. Do not retry on your own — ask the user.`;
    case 'abort':
      return `${did}: the turn was stopped before the user answered.`;
    case 'same-project':
      return 'That is this project — use your own tools for it.';
    default:
      return `${did}.`;
  }
}

export function makeCrossProjectGuard(deps: CrossProjectGuardDeps): CrossProjectGuard {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((kind, payload) => logActivity(kind, payload));
  /** One card per target at a time: a second call to the same project while
   *  the first card is open waits for the same answer. */
  const inFlight = new Map<string, Promise<Answer>>();

  const ask = (approvalId: string, input: CrossProjectApprovalInput): Promise<Answer> =>
    new Promise<Answer>((resolve) => {
      let settled = false;
      const escalates = deps.escalate?.enabled() ?? false;
      const settle = (a: Answer, reason?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        deps.signal.removeEventListener('abort', onAbort);
        unregisterApproval(approvalId);
        if (escalates) {
          deps.escalate!.finish({
            approvalId,
            decision: a === 'allow' || a === 'always' ? 'allow' : 'deny',
            ...(a !== 'allow' && a !== 'always' && reason ? { reason } : {}),
          });
        }
        resolve(a);
      };
      const onAbort = () => settle('abort', 'turn was stopped before approval');
      const timer = setTimeout(() => settle('timeout', 'approval request timed out'), deps.ttlMs);
      if (deps.signal.aborted) return onAbort();
      deps.signal.addEventListener('abort', onAbort);
      registerApproval(
        approvalId,
        // "Always allow" rides as an extra on an allow (`always: true`). Telegram
        // answers yes/no only, so a phone "yes" is an allow-once.
        (d: GateDecision, extras?: ApprovalExtras) =>
          settle(
            d.behavior === 'allow' ? (extras?.always === true ? 'always' : 'allow') : 'deny',
            d.behavior === 'deny' ? d.reason : undefined,
          ),
        now(),
        { toolName: CROSS_PROJECT_ACCESS_TOOL },
      );
      log('approval_requested', {
        sessionId: deps.sessionId,
        approvalId,
        toolName: CROSS_PROJECT_ACCESS_TOOL,
        input,
        escalatedToTelegram: escalates,
        askedBy: CROSS_PROJECT_SOURCE,
      });
      deps.emit({
        type: 'approval_request',
        approvalId,
        tool_name: CROSS_PROJECT_ACCESS_TOOL,
        input,
        session_id: deps.sessionId,
        source: CROSS_PROJECT_SOURCE,
      });
      if (escalates) deps.escalate!.send({ approvalId, toolName: CROSS_PROJECT_ACCESS_TOOL, input });
    });

  return {
    async check(target, request) {
      const base = {
        sessionId: deps.sessionId,
        fromCwd: deps.cwd,
        targetCwd: target.cwd,
        feature: request.feature,
        op: request.op,
      };
      const standing = crossProjectStanding(deps.store, deps.cwd, target.cwd, deps.sessionId);
      const verdict = standing.access;
      if (verdict !== 'needs-approval') {
        log('cross_project_access', { ...base, relation: standing.relation, verdict });
        if (crossProjectAccessAllows(verdict)) return { ok: true, verdict };
        return { ok: false, verdict, content: refusalText(verdict, target.name, request.feature) };
      }

      let pending = inFlight.get(target.cwd);
      let approvalId: string | undefined;
      if (!pending) {
        approvalId = `${deps.sessionId}:${CROSS_PROJECT_ACCESS_TOOL}:${request.toolCallId}`;
        const id = approvalId;
        let numbered: ProjectNumber | undefined;
        try {
          numbered = readProjectNumbers(deps.store).get(target.cwd);
        } catch {
          numbered = undefined;
        }
        pending = ask(id, {
          project: target.name,
          cwd: target.cwd,
          kind: request.feature,
          ...(request.sessionTitle && !request.newSession ? { sessionTitle: request.sessionTitle } : {}),
          ...(request.feature === 'send' && request.newSession ? { newSession: true as const } : {}),
          ...(numbered ? { number: numbered.number, ...(numbered.groupName ? { section: numbered.groupName } : {}) } : {}),
          relation: standing.relation === 'same-group' ? 'same-group' : 'other-group',
          ...(standing.group ? { group: standing.group } : {}),
        }).then((answer) => {
          // R18: "always allow" is the directed pair in app.db; "decline" is
          // this session's; "allow once", a timeout and a stop store nothing.
          if (answer === 'always') {
            try {
              addCrossProjectApprovalPair(deps.store, deps.cwd, target.cwd, now());
            } catch (e) {
              console.warn('[crossProject] could not store the permanent approval:', e);
            }
          }
          if (answer === 'deny') recordCrossProjectDecline(deps.sessionId, target.cwd);
          inFlight.delete(target.cwd);
          log('approval_resolved', {
            sessionId: deps.sessionId,
            approvalId: id,
            toolName: CROSS_PROJECT_ACCESS_TOOL,
            decision: answer === 'allow' || answer === 'always' ? 'allow' : 'deny',
            outcome: answer,
          });
          deps.emit({
            type: 'approval_resolved',
            approvalId: id,
            decision: answer === 'allow' || answer === 'always' ? 'allow' : 'deny',
            ...(answer === 'always' ? { always: true } : {}),
            tool_name: CROSS_PROJECT_ACCESS_TOOL,
            source: CROSS_PROJECT_SOURCE,
            session_id: deps.sessionId,
          });
          return answer;
        });
        inFlight.set(target.cwd, pending);
      }
      const answer = await pending;
      log('cross_project_access', { ...base, relation: standing.relation, verdict, approval: answer });
      // "Allow once" covers the call(s) that were waiting on THIS card — they
      // were asked about together — and nothing after it: the next call asks.
      if (answer === 'allow' || answer === 'always') return { ok: true, verdict: answer === 'always' ? 'approved' : verdict };
      return {
        ok: false,
        verdict: answer === 'deny' ? 'denied' : 'needs-approval',
        content: refusalText(answer, target.name, request.feature),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// git (R13)
// ---------------------------------------------------------------------------

export type GitRun = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** `git <args>`, no shell. Optional locks off, so `status` never writes the
 *  index of a project naby is only looking at; no credential prompt. */
export const runGit: GitRun = (args) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        timeout: 15_000,
        // Far past the 64KB the model sees: the cut is `clipGitOutput`'s, on a
        // character boundary, not the buffer's.
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
      },
      (err, stdout, stderr) => {
        const errCode = (err as { code?: unknown } | null)?.code;
        // A huge diff past the buffer is still an answer — it is cut below anyway.
        const overflow = errCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        const code = !err || overflow ? 0 : typeof errCode === 'number' ? errCode : 1;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code !== 0 ? err.message : '') });
      },
    );
  });

// ---------------------------------------------------------------------------
// The two tools (R11)
// ---------------------------------------------------------------------------

export interface CrossProjectToolDeps {
  store: CrossProjectStore;
  sessionId: string;
  /** This turn's project. The tools are only built when there is one. */
  cwd: string;
  guard: CrossProjectGuard;
  /** Tests may replace git. */
  git?: GitRun;
}

const refuse = (content: string): ToolOutput => ({ content, isError: true });

/** Run one file op with the runtime's own read executor, rooted at `cwd`. */
async function readFileOp(cwd: string, input: ReadProjectInput, ctx: Parameters<Executor>[1]): Promise<ToolOutput> {
  // The fs executors check containment lexically; a link out of another
  // project's folder must not be followed (§9).
  const bad = checkRealPathInside(cwd, input.path);
  if (bad) return refuse(bad);
  switch (input.op) {
    case 'read_file':
      return makeReadFile(cwd)(
        { path: input.path, ...(input.offset ? { offset: input.offset } : {}), ...(input.limit ? { limit: input.limit } : {}) },
        ctx,
      );
    case 'list_dir':
      return makeListDir(cwd)({ path: input.path ?? '.' }, ctx);
    case 'glob':
      return makeGlob(cwd)({ pattern: input.pattern, path: input.path ?? '.' }, ctx);
    case 'grep':
      return makeGrep(cwd)(
        {
          pattern: input.pattern,
          path: input.path ?? '.',
          ...(input.glob ? { glob: input.glob } : {}),
          ...(input.ignoreCase ? { ignoreCase: true } : {}),
        },
        ctx,
      );
    default:
      return refuse(`${input.op} is not a file op`);
  }
}

async function gitOp(cwd: string, input: ReadProjectInput, git: GitRun): Promise<ToolOutput> {
  const built = buildGitArgs(cwd, input);
  if (!built.ok) return refuse(built.error);
  const failed = (o: { code: number; stderr: string }): ToolOutput =>
    /not a git repository/i.test(o.stderr)
      ? refuse('That project is not a git repository.')
      : refuse(`git failed: ${o.stderr.trim().slice(0, 500) || `exit ${o.code}`}`);
  // git_show: the commit header first (it has no paths, so nothing outside the
  // folder), then the stat and patch limited to the folder.
  let header = '';
  if (built.headerArgs) {
    const h = await git(built.headerArgs);
    if (h.code !== 0) return failed(h);
    header = h.stdout.trimEnd();
  }
  const out = await git(built.args);
  if (out.code !== 0) return failed(out);
  const body = header
    ? `${header}\n\n${out.stdout.trim() ? out.stdout : '(this commit changes nothing inside the project folder)\n'}`
    : out.stdout;
  const clipped = clipGitOutput(body);
  const text = clipped.text.trim() ? clipped.text : '(no output)';
  return {
    content: clipped.truncated ? `${text}\n… output cut at ${CROSS_PROJECT_GIT_OUTPUT_MAX_BYTES / 1024}KB.` : text,
    data: { truncated: clipped.truncated },
  };
}

/** Build `naby_list_projects` + `naby_read_project` for one turn. */
export function makeCrossProjectTools(deps: CrossProjectToolDeps): {
  schemas: ToolSchema[];
  executors: Record<string, Executor>;
} {
  const git = deps.git ?? runGit;

  const list: Executor = async () => {
    const rows = listCrossProjects(deps.store, deps.cwd, deps.sessionId);
    if (rows.length === 0) return { content: 'There is no other project in the sidebar list.', data: { projects: [] } };
    const numbers = readProjectNumbers(deps.store);
    const label = (cwd: string, group: string | undefined) => {
      const n = numbers.get(cwd);
      return n ? `${group ? `group "${group}"` : 'no group'} #${n.number}` : group ? `group "${group}"` : 'no group';
    };
    const self = numbers.get(deps.cwd);
    const lines = rows.map(
      (r) => `- [${label(r.cwd, r.group)}] "${r.name}" — ${r.cwd} — relation: ${r.relation} — access: ${r.access}`,
    );
    const head = self
      ? `This project is ${self.groupName ? `group "${self.groupName}"` : 'in no group'} #${self.number}. ` +
        'Sidebar numbers restart at 1 in each group (the ungrouped area counts on its own); pass "3" for a number in this project\'s section, or "<group> 3" for another.'
      : 'Sidebar numbers restart at 1 in each group (the ungrouped area counts on its own).';
    return { content: `${head}\nOther projects:\n${lines.join('\n')}`, data: { projects: rows } };
  };

  const read: Executor = async (raw, ctx) => {
    const parsed = parseReadProjectInput(raw);
    if (!parsed.ok) return refuse(`Not read: ${parsed.error}.`);
    const input = parsed.input;
    // A cwd, a name or a sidebar number (R7a, R7b) — resolved here, with the
    // sidebar's own numbers; the model never counts.
    const ref = resolveProjectRef(projectRefCandidates(deps.store), input.project, { selfCwd: deps.cwd });
    if (!ref.ok) return refuse(`Not read: ${ref.error}.`);
    const target = { cwd: ref.cwd, name: ref.name };
    const access = await deps.guard.check(target, { feature: 'read', op: input.op, toolCallId: ctx.toolCall.toolCallId });
    if (!access.ok) return refuse(access.content);

    const out = input.op.startsWith('git_') ? await gitOp(target.cwd, input, git) : await readFileOp(target.cwd, input, ctx);
    return {
      content: formatCrossProjectResult({ project: target, op: input.op, body: out.content }),
      ...(out.isError ? { isError: true } : {}),
      data: { project: target.name, cwd: target.cwd, op: input.op, ...(out.data && typeof out.data === 'object' ? { result: out.data } : {}) },
    };
  };

  return {
    schemas: [LIST_PROJECTS_TOOL_SCHEMA, READ_PROJECT_TOOL_SCHEMA],
    executors: {
      [LIST_PROJECTS_TOOL_SCHEMA.name]: list,
      [READ_PROJECT_TOOL_SCHEMA.name]: read,
    },
  };
}
