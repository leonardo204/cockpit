import { CG_PROMPT_EN, CG_PROMPT_ZH } from './cgPrompt';

export const COMMAND_CONTENT: Record<string, Record<string, string>> = {
  qa: {
    zh: `进入需求澄清讨论模式
尝试理解用户的需求并给出你对需求的理解，有不明确的点需要向我确认，避免理解不一致而导致无效的代码修改
遵循 KISS 原则
输出理解，不改代码`,
    en: `Enter requirement clarification mode.
Understand the user's needs and state your understanding.
Ask for clarification on ambiguous points to avoid unnecessary code changes.
Follow the KISS principle.
Output your understanding only; do not modify code.`,
  },
  fx: {
    zh: `进入bug证据链分析模式，只分析不修改代码，给出详细推理过程`,
    en: `Enter bug evidence chain analysis mode.
Analyze only; do not modify code.
Provide a detailed reasoning process.`,
  },
  // /cg is heavy (~2500 chars) and tightly coupled to the codegraph endpoints
  // — kept in its own file (cgPrompt.ts) so this registry stays a thin index.
  cg: {
    zh: CG_PROMPT_ZH,
    en: CG_PROMPT_EN,
  },
};

/**
 * Derive the base URL the AI should use in its curl recipes.
 *
 * Why we can't hard-code `http://localhost:<port>`: cockpit may be deployed
 * behind a reverse proxy (nginx / Cloudflare / Tailscale Funnel / etc) at a
 * public URL like `https://cockpit.example.com`. The AI runs bash on the
 * server, so localhost would actually work for the curl execution itself —
 * but the curl command is ALSO shown to the user as part of the AI's
 * reasoning. If the user is on a different machine, "curl localhost:3457"
 * is unreproducible noise.
 *
 * Precedence:
 *   1. X-Forwarded-Proto / X-Forwarded-Host  (reverse proxy: trust them)
 *   2. req.url's origin                       (direct connection: use it)
 *
 * The fallback (no req at all) is `http://localhost:<COCKPIT_PORT>`, used by
 * call sites that don't have a Request handy (rare; tests / CLI).
 */
function deriveBaseUrl(req?: Request): string {
  if (req) {
    const url = new URL(req.url);
    const proto = req.headers.get('x-forwarded-proto');
    const host = req.headers.get('x-forwarded-host');
    if (proto || host) {
      return `${proto ?? url.protocol.replace(':', '')}://${host ?? url.host}`;
    }
    return url.origin;
  }
  const port = process.env.COCKPIT_PORT || process.env.PORT || '3457';
  return `http://localhost:${port}`;
}

// Expands /qa, /fx, /cg etc. into their full instruction text before the
// prompt is sent to the model. Reads COMMAND_CONTENT keyed by the verb after
// the slash and the user's language (zh / en).
//
// `{{BASE_URL}}` placeholders inside the content are substituted with the
// live base URL derived from the incoming request (or fallback to
// http://localhost:<port>). This makes /cg's curl recipes reachable from
// whatever URL the user actually sees cockpit at — localhost for local dev,
// the deployment's public URL when behind a reverse proxy.
export function resolveCommandPrompt(
  prompt: string,
  language = 'en',
  req?: Request,
): string {
  const trimmed = prompt.trimStart();
  const match = trimmed.match(/^\/([a-zA-Z]+)(?:\s+|$)/);
  if (!match) return prompt;

  const cmd = match[1];
  const lang = language.startsWith('zh') ? 'zh' : 'en';
  const tmpl = COMMAND_CONTENT[cmd]?.[lang];
  if (!tmpl) return prompt;

  const baseUrl = deriveBaseUrl(req);
  const content = tmpl.replaceAll('{{BASE_URL}}', baseUrl);

  const rest = trimmed.slice(match[0].length).trimStart();
  // The label prepended to the user's trailing text isn't just a separator —
  // it's a mindset primer for the model. `/cg` switches the user into project
  // graph EXPLORATION; tagging the input "探索问题" / "Exploration:" up-front
  // anchors the model on graph-tool usage instead of defaulting to grep/glob.
  // Other commands keep the neutral "问题：" / "Question:" label.
  const label = labelFor(cmd, lang, rest);
  return rest ? `${content}\n\n${label}${rest}` : content;
}

/** Pick the right "label:" prefix for a command's trailing user text. Defaults
 *  to a neutral question label; specific commands (currently only `/cg`)
 *  override to prime a stronger mindset. */
function labelFor(cmd: string, lang: 'zh' | 'en', _rest: string): string {
  if (cmd === 'cg') return lang === 'zh' ? '探索问题：' : 'Exploration: ';
  return lang === 'zh' ? '问题：' : 'Question: ';
}
