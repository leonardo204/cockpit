/**
 * auth.ts — shared-token access gate (opt-in via `cockpit --token <value>`).
 *
 * Consumed by server.mjs (plain boot): the request / upgrade / share gate. Kept
 * stdlib-only (node:crypto) and NOT Effect-wrapped so it imports cleanly into
 * the plain server boot. (Outside the EFFECT.md enforced globs — src/app/api/**
 * + src/lib/effect/** — so plain code is fine here.)
 *
 * Model (KISS):
 *   - Token mode is OFF unless COCKPIT_TOKEN is set (the --token flag sets it) →
 *     when off, everything is open (backward compatible).
 *   - When on, LOCAL requests are exempt; every non-local request must present
 *     the token (cookie / Authorization: Bearer / ?token=).
 *
 * "Local" = the TCP peer is loopback AND the request carries no forwarding
 * header. socket.remoteAddress can't be spoofed by a client; the forwarding-
 * header check defeats same-host proxies/tunnels (ngrok / Caddy / nginx) which
 * connect over loopback but relay a remote user — they all set X-Forwarded-For,
 * so a forwarded request never counts as local. The only blind spot is a
 * same-host proxy that strips all forwarding headers (a misconfiguration);
 * that is indistinguishable from genuine localhost and cannot be told apart.
 */
import { timingSafeEqual } from 'crypto';

export const COOKIE_NAME = 'cockpit_token';
const QUERY_KEY = 'token';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export function tokenEnabled(): boolean {
  return Boolean(process.env.COCKPIT_TOKEN);
}

function configuredToken(): string {
  return process.env.COCKPIT_TOKEN || '';
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function isLoopbackAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.startsWith('127.')
  );
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenFromQuery(url: string): string | undefined {
  try {
    return new URL(url, 'http://localhost').searchParams.get(QUERY_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

// Same URL minus the ?token= param (so the secret doesn't linger in the address
// bar / history after the cookie is set).
function stripTokenParam(url: string): string {
  try {
    const u = new URL(url, 'http://localhost');
    u.searchParams.delete(QUERY_KEY);
    const qs = u.searchParams.toString();
    return u.pathname + (qs ? `?${qs}` : '') + (u.hash || '');
  } catch {
    return '/';
  }
}

export function makeCookie(token: string, secure: boolean): string {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export interface AccessInput {
  url: string;
  remoteAddr: string | undefined;
  cookieHeader: string | undefined;
  authHeader: string | undefined;
  /** Presence of any forwarding header → relayed by a proxy/tunnel. */
  forwarded: string | undefined;
  isWs: boolean;
  isHttps: boolean;
}

export type AccessDecision =
  | { action: 'pass' }
  | { action: 'redirect'; location: string; setCookie: string }
  | { action: 'deny' };

export function checkAccess(input: AccessInput): AccessDecision {
  // Token mode off → fully open (backward compatible).
  if (!tokenEnabled()) return { action: 'pass' };

  // Local callers (CLI / /cg curls / self-probe / browser on the host) are
  // exempt: genuine loopback peer with no forwarding header.
  if (!input.forwarded && isLoopbackAddr(input.remoteAddr)) {
    return { action: 'pass' };
  }

  const want = configuredToken();

  const cookieTok = parseCookies(input.cookieHeader)[COOKIE_NAME];
  if (cookieTok && safeEqual(cookieTok, want)) return { action: 'pass' };

  const auth = input.authHeader;
  const bearer =
    auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
  if (bearer && safeEqual(bearer, want)) return { action: 'pass' };

  const queryTok = tokenFromQuery(input.url);
  if (queryTok && safeEqual(queryTok, want)) {
    // WS can't carry a redirect — just accept the query token.
    if (input.isWs) return { action: 'pass' };
    // First visit via ?token= → set the cookie and bounce to a clean URL.
    return {
      action: 'redirect',
      location: stripTokenParam(input.url),
      setCookie: makeCookie(want, input.isHttps),
    };
  }

  return { action: 'deny' };
}
