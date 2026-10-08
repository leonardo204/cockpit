'use client';

/**
 * The Atlassian browser sign-in requests (org-harness-sync §3.8), shared by the
 * Settings card's button (workspace `AtlassianLoginButton`) and the chat status
 * bar. One place posts `atlassian.login` / `atlassian.cancelLogin` and opens the
 * authorization URL, so the two entry points cannot drift apart.
 *
 * `window.open` is handed to the system browser by the app's window-open
 * handler (electron/boot.ts) — from the top window and from a project iframe
 * alike; in a plain browser it opens a tab.
 *
 * After either call the connection status is re-read here and announced to the
 * other frames (`ConnectionsChanged`), so every status bar and the Settings card
 * see the pending sign-in at once; the status store then polls every 2 s until
 * the sign-in lands.
 */

import { announceTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';
import { refreshConnectionStatus } from './connectionStatus';

export type AtlassianLoginReply<S> =
  | { ok: true; orgHarness?: S; authorizationUrl?: string }
  | { ok: false; error: string };

async function post<S>(body: Record<string, unknown>): Promise<AtlassianLoginReply<S>> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; orgHarness?: S; authorizationUrl?: string; error?: string }
      | null;
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return {
      ok: true,
      ...(json.orgHarness ? { orgHarness: json.orgHarness } : {}),
      ...(typeof json.authorizationUrl === 'string' ? { authorizationUrl: json.authorizationUrl } : {}),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Tell every frame (and this one) to re-read the connection status. */
export function announceConnectionsChanged(): void {
  void refreshConnectionStatus();
  try {
    announceTopic(Topics.ConnectionsChanged, {});
  } catch {
    /* no bus (tests, SSR): the local refresh above is enough */
  }
}

/**
 * Start the sign-in: the server opens its loopback listener and answers with the
 * authorization URL, which is opened here. `S` is the org harness state type the
 * caller reads from the reply (the Settings card wants it; the bar does not).
 */
export async function startAtlassianLoginFlow<S = unknown>(): Promise<AtlassianLoginReply<S>> {
  const r = await post<S>({ action: 'atlassian.login' });
  if (r.ok && r.authorizationUrl && typeof window !== 'undefined') {
    window.open(r.authorizationUrl, '_blank', 'noopener');
  }
  announceConnectionsChanged();
  return r;
}

export async function cancelAtlassianLoginFlow<S = unknown>(): Promise<AtlassianLoginReply<S>> {
  const r = await post<S>({ action: 'atlassian.cancelLogin' });
  announceConnectionsChanged();
  return r;
}

/** `orgHarness.get`, for the Settings card's own 2 s poll. */
export function readOrgHarnessForLogin<S = unknown>(): Promise<AtlassianLoginReply<S>> {
  return post<S>({ action: 'orgHarness.get' });
}
