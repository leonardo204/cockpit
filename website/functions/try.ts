/**
 * Cloudflare Pages Function — `/try` (Try Online demo entrypoint).
 *
 * Canonical handler for the demo flow under cocking.cc/try. (A Vercel-
 * hosted handler at `e2b/api/try.js` used to share this responsibility;
 * it was retired so the entire flow lives on Cloudflare Pages and
 * visitors never see vercel.app in their address bar. The `e2b/`
 * directory now only builds the sandbox template — see e2b/README.md.)
 *
 * Two-step flow:
 *   1. GET /try                            → confirmation page (also blocks link-preview bots)
 *   2. GET /try?confirm=1
 *        with Accept: application/json     → JSON { url } / 429 / 5xx (used by the in-page button)
 *        plain navigation                  → 302 to sandbox URL (no-JS fallback / direct share)
 *
 * The in-page "Start Demo" button uses fetch with `Accept: application/json`
 * so a cooldown / sandbox-create error stays on this page as a TOAST instead
 * of full-page-navigating to a raw JSON error response. Without that, slow
 * E2B responses arriving after the user has navigated away would lose the
 * sandbox URL, and 429 cooldowns would render `{"error":"..."}` literally.
 *
 * Cooldown: 5 minutes per visitor (cookie-based) to prevent abuse.
 * Required env binding (set in Cloudflare Pages dashboard → Settings → Variables):
 *   E2B_API_KEY  (server-side, never exposed to the browser)
 */

const COOLDOWN_MS = 5 * 60 * 1000;
const E2B_API = 'https://api.e2b.dev';

const CONFIRM_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Cockpit Demo</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #fff; }
  .card { text-align: center; max-width: 420px; padding: 0 24px; }
  h1 { font-size: 26px; margin: 0 0 12px; letter-spacing: -0.01em; }
  p { color: #999; margin: 0 0 28px; line-height: 1.5; }
  button { display: inline-block; padding: 12px 32px; background: #4ab9b3; color: #0a0a0a; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; font-family: inherit; cursor: pointer; transition: background 0.15s; }
  button:hover:not(:disabled) { background: #5fcdc7; }
  button:disabled { background: #1f2937; color: #6b7280; cursor: not-allowed; }
  .footnote { margin-top: 24px; font-size: 12px; color: #555; }
  /* Toast — fixed-position, slides up from the bottom, auto-dismisses
     after a few seconds. Stays put so the page layout doesn't shift. */
  #toast {
    position: fixed; bottom: 24px; left: 50%; transform: translate(-50%, 100px);
    background: #1f2937; color: #fff; padding: 12px 20px; border-radius: 8px;
    font-size: 14px; max-width: 90vw; box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    opacity: 0; transition: opacity 0.2s, transform 0.2s; pointer-events: none;
  }
  #toast.show { opacity: 1; transform: translate(-50%, 0); }
  #toast.error { background: #7f1d1d; }
</style></head>
<body><div class="card">
  <h1>Cockpit Demo</h1>
  <p>5-minute sandbox with Explorer &amp; Terminal.<br>(no AI chat in this demo)</p>
  <button id="start" type="button">Start Demo →</button>
  <noscript>
    <p style="margin-top: 16px; font-size: 13px;">
      <a href="?confirm=1" style="color: #4ab9b3;">Continue without JavaScript →</a>
    </p>
  </noscript>
  <div class="footnote">Sandbox launches on e2b.dev</div>
</div>
<div id="toast" role="status" aria-live="polite"></div>
<script>
  const btn = document.getElementById('start');
  const toast = document.getElementById('toast');
  let toastTimer;
  function showToast(message, isError) {
    toast.textContent = message;
    toast.classList.toggle('error', !!isError);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    // Cooldown text like "Please wait 280s..." is long enough that
    // the default 3s feels too short. 6s gives the user time to read.
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 6000);
  }
  btn.addEventListener('click', async function () {
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      const r = await fetch('?confirm=1', {
        // Tell the server we want JSON so it doesn't 302 us off-page.
        headers: { Accept: 'application/json' },
      });
      let data = {};
      try { data = await r.json(); } catch (_) {}
      if (r.ok && data.url) {
        // Successful sandbox creation — navigate to it.
        window.location.href = data.url;
        return;
      }
      // Rate-limit (429), server error (500/502/503), or any non-OK
      // with an error: stay on this page, show the toast, restore the
      // button so the user can retry once the cooldown elapses.
      showToast(data.error || 'Failed to start the demo. Please try again.', true);
      btn.disabled = false;
      btn.textContent = 'Start Demo →';
    } catch (err) {
      showToast('Network error: ' + (err && err.message ? err.message : String(err)), true);
      btn.disabled = false;
      btn.textContent = 'Start Demo →';
    }
  });
</script></body></html>`;

interface Env {
  E2B_API_KEY: string;
}

interface SandboxResponse {
  sandboxID: string;
  domain?: string;
}

function isBot(ua: string | null): boolean {
  if (!ua) return true;
  return /axios|curl|wget|python|bot|crawler|spider|scraper|preview|fetch|http\.client/i.test(ua);
}

function readCooldownCookie(cookieHeader: string | null): number {
  if (!cookieHeader) return 0;
  const match = cookieHeader.match(/(?:^|;\s*)cockpit_demo=(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);

  // Bot filter — including most link-preview crawlers (iMessage, Slack, etc.)
  if (isBot(request.headers.get('User-Agent'))) {
    return jsonError('Forbidden', 403);
  }

  // Step 1: confirmation page
  if (request.method === 'GET' && !url.searchParams.has('confirm')) {
    return new Response(CONFIRM_HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex',
      },
    });
  }

  // The in-page "Start Demo" button sends `Accept: application/json` to
  // tell us not to 302 the response — that way 429 cooldowns or 5xx
  // errors stay on the confirm page (rendered as a toast) instead of
  // navigating the browser to a raw JSON error body. No-JS / direct
  // share / curl get the original 302 redirect on success.
  const wantsJson = (request.headers.get('Accept') || '').includes('application/json');

  // Step 2: cooldown check
  const lastTry = readCooldownCookie(request.headers.get('Cookie'));
  const now = Date.now();
  if (lastTry && now - lastTry < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - (now - lastTry)) / 1000);
    return jsonError(`Please wait ${waitSec}s before trying again.`, 429);
  }

  if (!env.E2B_API_KEY) {
    console.error('[/try] E2B_API_KEY is not configured');
    return jsonError('Demo is temporarily unavailable.', 503);
  }

  // Step 3: create sandbox via E2B API
  try {
    const apiRes = await fetch(`${E2B_API}/sandboxes`, {
      method: 'POST',
      headers: {
        'X-API-Key': env.E2B_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateID: 'cockpit-demo',
        timeout: 300,
      }),
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      console.error('[/try] E2B API error:', apiRes.status, errBody);
      return jsonError('Failed to create demo sandbox.', 502);
    }

    const sandbox = (await apiRes.json()) as SandboxResponse;
    const domain = sandbox.domain || 'e2b.dev';
    const sandboxUrl = `https://3457-${sandbox.sandboxID}.${domain}/?cwd=${encodeURIComponent('/home/user/demo-project')}`;

    // Success: cookie is written either way; only the body shape differs.
    const cookieHeader = `cockpit_demo=${now}; Path=/; Max-Age=300; SameSite=Lax; Secure`;
    if (wantsJson) {
      return new Response(JSON.stringify({ url: sandboxUrl }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': cookieHeader,
          'Cache-Control': 'private, no-store',
        },
      });
    }
    return new Response(null, {
      status: 302,
      headers: {
        'Location': sandboxUrl,
        'Set-Cookie': cookieHeader,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    console.error('[/try] Failed to create sandbox:', err);
    return jsonError('Failed to create demo sandbox.', 500);
  }
};

// Type stub — Cloudflare provides the real type at runtime via @cloudflare/workers-types.
type PagesFunction<E = unknown> = (context: {
  request: Request;
  env: E;
  next: () => Promise<Response>;
  [key: string]: unknown;
}) => Response | Promise<Response>;
