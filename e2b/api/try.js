const COOLDOWN_MS = 5 * 60 * 1000;
const E2B_API = 'https://api.e2b.dev';

export default async function handler(req, res) {
  // Block known bots
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (!ua || /axios|curl|wget|python|bot|crawler|spider|scraper/.test(ua)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // The client decides format via the Accept header. The in-page
  // "Start Demo" button uses fetch with `Accept: application/json` so
  // the server responds with JSON instead of a 302 redirect — that
  // lets the page DISPATCH the response into a toast (rate limit /
  // server error) or into a navigation (success) without ever taking
  // the user OFF this page mid-request. No-JS / direct-link fallback
  // still gets a 302 redirect on success so the page degrades gracefully.
  const wantsJson = (req.headers.accept || '').includes('application/json');

  // Step 1: Show confirmation page (blocks link preview bots)
  if (req.method === 'GET' && !req.query.confirm) {
    res.setHeader('Content-Type', 'text/html');
    return res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Cockpit Demo</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #fff; }
  .card { text-align: center; max-width: 400px; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  p { color: #888; margin-bottom: 24px; }
  button { display: inline-block; padding: 12px 32px; background: #2563eb; color: #fff; border: none; border-radius: 8px; font-size: 16px; font-family: inherit; cursor: pointer; transition: background 0.15s; }
  button:hover:not(:disabled) { background: #1d4ed8; }
  button:disabled { background: #1f2937; color: #6b7280; cursor: not-allowed; }
  /* Toast — slides up from the bottom, auto-dismisses after a few
     seconds. Fixed-positioned so the page layout doesn't shift when
     it appears / disappears. */
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
  <p>5-minute sandbox with Explorer &amp; Terminal<br>(no AI chat)</p>
  <button id="start" type="button">Start Demo</button>
  <noscript>
    <p style="margin-top: 16px; font-size: 13px;">
      <a href="?confirm=1" style="color: #60a5fa;">Continue without JavaScript →</a>
    </p>
  </noscript>
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
      // Rate-limit (429), server error (500), or any non-OK with an
      // error: stay on this page, show the toast, restore the button
      // so the user can retry once the cooldown elapses.
      showToast(data.error || 'Failed to start the demo. Please try again.', true);
      btn.disabled = false;
      btn.textContent = 'Start Demo';
    } catch (err) {
      showToast('Network error: ' + (err && err.message ? err.message : String(err)), true);
      btn.disabled = false;
      btn.textContent = 'Start Demo';
    }
  });
</script></body></html>`);
  }

  // Step 2: Create sandbox (only when user clicks "Start Demo")
  const lastTry = parseInt(req.cookies?.cockpit_demo || '0', 10);
  const now = Date.now();
  if (lastTry && now - lastTry < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - (now - lastTry)) / 1000);
    return res.status(429).json({
      error: `Please wait ${waitSec}s before trying again.`,
    });
  }

  try {
    const response = await fetch(`${E2B_API}/sandboxes`, {
      method: 'POST',
      headers: {
        'X-API-Key': process.env.E2B_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateID: 'cockpit-demo',
        timeout: 300,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('E2B API error:', response.status, error);
      throw new Error(error);
    }

    const sandbox = await response.json();
    const domain = sandbox.domain || 'e2b.dev';
    const url = `https://3457-${sandbox.sandboxID}.${domain}/?cwd=${encodeURIComponent('/home/user/demo-project')}`;

    res.setHeader('Set-Cookie', `cockpit_demo=${now}; Path=/; Max-Age=300; SameSite=Lax`);

    // Browsers fetching with `Accept: application/json` (the in-page
    // button) get the URL to navigate themselves; everything else
    // (no-JS fallback, direct link share) gets a 302 redirect.
    if (wantsJson) {
      return res.status(200).json({ url });
    }
    return res.redirect(302, url);
  } catch (error) {
    console.error('Failed to create sandbox:', error);
    res.status(500).json({ error: 'Failed to create demo sandbox.' });
  }
}
