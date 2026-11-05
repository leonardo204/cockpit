/**
 * NABY REACHING INTO ANOTHER PROJECT — the access card's data
 * (specs/cross-project-context.md R17). Pure, so the card's rules are tested
 * without a DOM.
 *
 * The server raises it as an `approval_request` with `source:'cross_project'`
 * and `tool_name:'cross_project.access'` when a read or a request goes to
 * another project the user has not allowed permanently — same sidebar group
 * included. Three answers (R17): allow once (nothing stored, the next call asks
 * again), always allow (a directed project pair kept in app.db, R18 — never a
 * policy rule), or decline (this session only).
 */

export const CROSS_PROJECT_SOURCE = 'cross_project';
export const CROSS_PROJECT_ACCESS_TOOL = 'cross_project.access';

/** The card as it draws. */
export interface CrossProjectAccessCard {
  /** The project's display name. */
  project: string;
  cwd: string;
  /** `read`: files / git. `send`: a request to one of its tabs. */
  kind: 'read' | 'send';
  /** `send`: the target tab's title. */
  sessionTitle?: string;
  /** `send` with no open tab there: a new conversation is opened for the
   *  request (cross-project-context R7d). */
  newSession?: boolean;
  /** R7e: the sidebar number, and its section's group name (absent in the
   *  ungrouped area) — "RMS 3번 ‹DT_RMS›". */
  number?: number;
  section?: string;
  /** Which group line the card shows (R17): the shared group, or "another group". */
  relation: 'same-group' | 'other-group';
  /** `same-group`: the group's name. */
  group?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read the card off a raw `approval_request` detail, or `null` when it is not one. */
export function crossProjectFromApproval(d: Record<string, unknown>): CrossProjectAccessCard | null {
  if (d.source !== CROSS_PROJECT_SOURCE) return null;
  const input = isObj(d.input) ? d.input : {};
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  if (!cwd) return null;
  const project = typeof input.project === 'string' && input.project.trim() ? input.project.trim() : cwd;
  const kind = input.kind === 'send' ? 'send' : 'read';
  const sessionTitle = typeof input.sessionTitle === 'string' && input.sessionTitle.trim() ? input.sessionTitle.trim() : undefined;
  const group = typeof input.group === 'string' && input.group.trim() ? input.group.trim() : undefined;
  const relation = input.relation === 'same-group' && group ? 'same-group' : 'other-group';
  const newSession = kind === 'send' && input.newSession === true;
  const number =
    typeof input.number === 'number' && Number.isInteger(input.number) && input.number > 0 ? input.number : undefined;
  const section = typeof input.section === 'string' && input.section.trim() ? input.section.trim() : undefined;
  return {
    project,
    cwd,
    kind,
    ...(kind === 'send' && sessionTitle && !newSession ? { sessionTitle } : {}),
    ...(newSession ? { newSession: true } : {}),
    ...(number !== undefined ? { number, ...(section ? { section } : {}) } : {}),
    relation,
    ...(relation === 'same-group' ? { group } : {}),
  };
}

/** The i18n key of the card's group line (R17). */
export function crossProjectGroupNoteKey(card: CrossProjectAccessCard): {
  key: string;
  defaultValue: string;
  params: Record<string, string>;
} {
  return card.relation === 'same-group' && card.group
    ? {
        key: 'toolApproval.crossProject.groupNoteSame',
        defaultValue: 'It is a project in the same group, ‹{{group}}›.',
        params: { group: card.group },
      }
    : {
        key: 'toolApproval.crossProject.groupNote',
        defaultValue: 'This project is in a different group from the current one.',
        params: {},
      };
}

/** The i18n key of the card's question line. */
export function crossProjectQuestionKey(card: CrossProjectAccessCard): {
  key: string;
  defaultValue: string;
} {
  if (card.kind === 'send' && card.newSession) {
    return {
      key: 'toolApproval.crossProject.sendNew',
      defaultValue: 'naby wants to open a new conversation in another project, {{project}} ({{cwd}}), and send it a request.',
    };
  }
  return card.kind === 'send'
    ? {
        key: 'toolApproval.crossProject.send',
        defaultValue: 'naby wants to send a request to the tab ‹{{title}}› of another project, {{project}} ({{cwd}}).',
      }
    : {
        key: 'toolApproval.crossProject.read',
        defaultValue: 'naby wants to read the contents of another project, {{project}} ({{cwd}}).',
      };
}

/** R7e: the i18n key of the project's label when it has a sidebar number —
 *  "RMS 3번 ‹DT_RMS›", or "3번 ‹DT_RMS›" in the ungrouped area. Null: the
 *  plain "‹DT_RMS›". */
export function crossProjectLabelKey(card: CrossProjectAccessCard): {
  key: string;
  defaultValue: string;
  params: Record<string, string | number>;
} | null {
  if (card.number === undefined) return null;
  return card.section
    ? {
        key: 'toolApproval.crossProject.projectNumbered',
        defaultValue: '{{section}} #{{number}} ‹{{project}}›',
        params: { section: card.section, number: card.number, project: card.project },
      }
    : {
        key: 'toolApproval.crossProject.projectNumberedNoGroup',
        defaultValue: '#{{number}} ‹{{project}}›',
        params: { number: card.number, project: card.project },
      };
}

/** One run of the question line: plain text, the project name, or the cwd. */
export type QuestionPart = { kind: 'text' | 'project' | 'cwd'; text: string };

const SLOT_PROJECT = '\u0001P\u0001';
const SLOT_CWD = '\u0001C\u0001';

/** The interpolation values that mark where the name and the cwd go, so the
 *  card can draw the name bold and the cwd as code (R17's copy). */
export const QUESTION_SLOTS = { project: SLOT_PROJECT, cwd: SLOT_CWD } as const;

/** Split a translated question (made with QUESTION_SLOTS) into runs. The name is
 *  wrapped in ‹› as everywhere else naby names a thing; `projectLabel` (the
 *  numbered label, R7e) replaces it whole when given. */
export function splitQuestion(translated: string, card: CrossProjectAccessCard, projectLabel?: string): QuestionPart[] {
  const out: QuestionPart[] = [];
  for (const piece of translated.split(/(\u0001[PC]\u0001)/)) {
    if (!piece) continue;
    if (piece === SLOT_PROJECT) out.push({ kind: 'project', text: projectLabel || `‹${card.project}›` });
    else if (piece === SLOT_CWD) out.push({ kind: 'cwd', text: card.cwd });
    else out.push({ kind: 'text', text: piece });
  }
  return out;
}
