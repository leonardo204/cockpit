// Korean particles that depend on the word before them — 이/가, 은/는, 을/를,
// 과/와, 으로/로. A ko string cannot hard-code one after an interpolated name:
// "{{name}}가" reads "앱스토어 심사 담당가", which is plainly wrong. The ko
// dictionary writes `{{name, iga}}` instead and this picks the particle from the
// name's last sound.

export type JosaKind = 'iga' | 'eunneun' | 'eulreul' | 'gwawa' | 'euro';

const PAIRS: Record<JosaKind, readonly [withFinal: string, withoutFinal: string]> = {
  iga: ['이', '가'],
  eunneun: ['은', '는'],
  eulreul: ['을', '를'],
  gwawa: ['과', '와'],
  euro: ['으로', '로'],
};

// Final consonant of each digit as read in Sino-Korean (영 일 이 삼 사 오 육 칠 팔 구).
const DIGIT_FINAL: Record<string, 'none' | 'rieul' | 'other'> = {
  '0': 'other', '1': 'rieul', '2': 'none', '3': 'other', '4': 'none',
  '5': 'none', '6': 'other', '7': 'rieul', '8': 'rieul', '9': 'none',
};

/** Whether the word's last sound has a final consonant, and whether it is ㄹ
 *  (which takes 로, not 으로). Latin letters are a best guess by spelling. */
export function finalSound(word: string): 'none' | 'rieul' | 'other' {
  const trimmed = word.replace(/[\s"'”’)\]}>.,!?…]+$/u, '');
  const ch = trimmed.slice(-1);
  if (!ch) return 'none';
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    if (jong === 0) return 'none';
    return jong === 8 ? 'rieul' : 'other';
  }
  if (ch in DIGIT_FINAL) return DIGIT_FINAL[ch];
  // A short Latin run (md, PR, API) is read letter by letter: only L/R (엘, 알)
  // and M/N (엠, 엔) end in a consonant. Longer runs are read as words.
  const run = /[A-Za-z]+$/.exec(trimmed)?.[0] ?? '';
  const lower = ch.toLowerCase();
  if (run.length > 0 && run.length <= 3) {
    if (lower === 'l' || lower === 'r') return 'rieul';
    return lower === 'm' || lower === 'n' ? 'other' : 'none';
  }
  if (lower === 'l') return 'rieul';
  if ('mnkptbgdcx'.includes(lower)) return 'other';
  return 'none';
}

/** The word followed by the right particle. */
export function withJosa(word: string, kind: JosaKind): string {
  const [withFinal, withoutFinal] = PAIRS[kind];
  const sound = finalSound(word);
  if (kind === 'euro') return word + (sound === 'other' ? withFinal : withoutFinal);
  return word + (sound === 'none' ? withoutFinal : withFinal);
}

export const JOSA_KINDS = Object.keys(PAIRS) as JosaKind[];
