// packages/feature/agent/src/server/lib/telegramChatStrings.ts
//
// EVERY WORD THE BOT SAYS, IN ONE PLACE (telegram-chat §2).
//
// The bot talks to ONE person — the owner of the configured chat_id — and that
// person's app locale is Korean, so the replies are Korean. This is not the
// shell's i18n: those dictionaries are client bundles keyed by the browser's
// language, and a background poll loop has no browser and no request to read a
// locale from. Keeping the copy here (rather than inline in the handlers) is
// what makes it localizable later: one module to key by locale, no handler to
// touch.
//
// The COMMAND TOKENS stay English (`/sessions`, `/use 3`) because they are the
// literal input Telegram autocompletes — translating them would name commands
// that do not exist.

/** A session as it reads in the list — the numbering IS the interface. */
export type SessionLine = {
  /** 1-based, as shown. */
  n: number;
  title: string;
  /** Project label (basename of the cwd), or undefined for a projectless one. */
  project?: string;
  /** Human "3분 전" style age. */
  age: string;
};

export type ProjectLine = { n: number; title: string; cwd: string };

/** Rough age in Korean. Deliberately coarse: on a phone the difference between
 *  41 and 47 minutes never changes what the user does next. */
export function formatAge(deltaMs: number): string {
  const min = Math.floor(deltaMs / 60_000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}

export const STR = {
  help: [
    '🦋 naby 봇 사용법',
    '',
    '/sessions — 최근 세션 목록',
    '/use N — N번 세션을 이 채팅에 연결',
    '/new [프로젝트번호] — 새 세션을 만들어 연결',
    '/projects — 프로젝트 목록',
    '/status — 연결 상태',
    '/stop — 연결 해제',
    '/help — 이 안내',
    '',
    '연결한 뒤에는 그냥 메시지를 보내면 그 세션의 턴이 된다. 답변 메시지에 답장하면 그 답변이 나온 세션으로 간다.',
  ].join('\n'),

  unknownCommand: (cmd: string): string =>
    `모르는 명령이다: /${cmd}\n/help로 쓸 수 있는 명령을 본다.`,

  noSessions: '세션이 하나도 없다. /new로 새 세션을 만든다.',

  sessionList: (lines: readonly SessionLine[]): string =>
    [
      '🗂 최근 세션',
      '',
      ...lines.map(
        (l) => `${l.n}. ${l.title}${l.project ? ` · ${l.project}` : ''} · ${l.age}`,
      ),
      '',
      '/use N 으로 연결한다.',
    ].join('\n'),

  noProjects: '프로젝트가 없다. 앱에서 폴더를 한 번 열면 목록에 올라온다.',

  projectList: (lines: readonly ProjectLine[]): string =>
    ['📁 프로젝트', '', ...lines.map((l) => `${l.n}. ${l.title} — ${l.cwd}`), '', '/new N 으로 그 프로젝트에 새 세션을 만든다.'].join('\n'),

  useNeedsNumber: '번호가 필요하다. 예: /use 2 (목록은 /sessions)',

  staleList: '목록이 그새 바뀌었다. /sessions로 다시 보고 번호를 고른다.',

  outOfRange: (max: number): string => `1~${max} 사이의 번호를 고른다. 목록은 /sessions.`,

  linked: (title: string, project?: string): string =>
    `🔗 연결했다: ${title}${project ? ` · ${project}` : ''}\n이제 그냥 메시지를 보내면 이 세션의 턴이 된다.`,

  created: (title: string, project?: string): string =>
    `✨ 새 세션을 만들어 연결했다: ${title}${project ? ` · ${project}` : ''}`,

  unlinked: '🔌 연결을 해제했다. 다시 이으려면 /sessions → /use N.',

  notLinked: '연결된 세션이 없다. /sessions로 목록을 보고 /use N으로 연결한다.',

  statusLinked: (opts: { title: string; project?: string; idle: string; running: boolean }): string =>
    [
      `🔗 연결됨: ${opts.title}${opts.project ? ` · ${opts.project}` : ''}`,
      `마지막 활동: ${opts.idle}`,
      opts.running ? '지금 작업 중이다.' : '지금은 쉬고 있다.',
    ].join('\n'),

  expired: '⏳ 연결이 오래되어 해제되었다. 계속하려면 /sessions로 목록을 보고 /use N으로 다시 연결한다.',

  sessionGone: '🗑 연결했던 세션이 사라졌다(앱에서 삭제된 듯하다). 연결을 해제했으니 /sessions로 다시 고른다.',

  busy: '⏳ 지금 작업 중이다 — 끝나면 알림이 간다.',

  working: '⏳ 작업 중...',

  dispatchFailed: (why: string): string => `⚠️ 턴을 시작하지 못했다: ${why}`,

  textOnly: '지금은 텍스트만 받는다. 사진이나 파일은 아직 지원하지 않는다.',
} as const;

/** The command menu as `setMyCommands` takes it. Descriptions are Korean; the
 *  commands themselves are the literal tokens Telegram autocompletes. */
export const BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'sessions', description: '최근 세션 목록' },
  { command: 'use', description: 'N번 세션을 이 채팅에 연결' },
  { command: 'new', description: '새 세션을 만들어 연결' },
  { command: 'projects', description: '프로젝트 목록' },
  { command: 'status', description: '연결 상태 보기' },
  { command: 'stop', description: '연결 해제' },
  { command: 'help', description: '사용법 안내' },
];
