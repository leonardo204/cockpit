/**
 * Web Push core (server-only).
 *
 * Standard W3C Push + VAPID — no Google/Firebase registration, no API keys.
 * We self-generate a VAPID keypair (stored in settings.json), the browser
 * hands us a push endpoint per subscription, and web-push signs the request
 * with our private key. Outbound HTTPS to the browser's push service (FCM /
 * Mozilla autopush / Apple) is all that's required.
 */
import webpush from 'web-push';
import {
  SETTINGS_FILE,
  PUSH_SUBSCRIPTIONS_FILE,
  readJsonFile,
  writeJsonFile,
  withFileLock,
} from '@cockpit/shared-utils';

export interface PushVapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

interface Settings {
  push?: PushVapid;
  [k: string]: unknown;
}

interface SubStore {
  subscriptions: webpush.PushSubscription[];
}

export interface PushPayload {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

// Cache the configured keypair so web-push.setVapidDetails runs once per process.
let configured: PushVapid | null = null;

// VAPID JWT `sub`. Apple's push service (web.push.apple.com) rejects a `sub`
// that points at localhost or is otherwise malformed with 403 BadJwtToken —
// while FCM ignores it, so the failure shows up only on iOS. Must be a valid
// https: URL or a mailto: with a real (dotted) domain.
const DEFAULT_SUBJECT = 'https://github.com/Surething-io/cockpit';

function isValidVapidSubject(sub: string | undefined): sub is string {
  if (!sub || sub.includes('localhost')) return false;
  if (sub.startsWith('https://')) return true;
  const m = /^mailto:[^\s@]+@([^\s@]+)$/.exec(sub);
  return !!m && m[1].includes('.');
}

/**
 * Get the VAPID keypair, generating + persisting it on first use. Merges into
 * settings.json without clobbering other sections. Also migrates a previously
 * persisted invalid subject (e.g. the old mailto:cockpit@localhost default that
 * broke Apple/iOS delivery) to a valid one.
 */
export async function getVapid(): Promise<PushVapid> {
  if (configured) return configured;
  const vapid = await withFileLock(SETTINGS_FILE, async () => {
    const settings = await readJsonFile<Settings>(SETTINGS_FILE, {});
    if (settings.push?.publicKey && settings.push?.privateKey) {
      const subject = isValidVapidSubject(settings.push.subject)
        ? settings.push.subject
        : DEFAULT_SUBJECT;
      // Heal a bad persisted subject in place so iOS pushes stop getting
      // rejected — the keypair is untouched, so existing subscriptions stay valid.
      if (subject !== settings.push.subject) {
        await writeJsonFile(SETTINGS_FILE, {
          ...settings,
          push: { ...settings.push, subject },
        });
      }
      return {
        publicKey: settings.push.publicKey,
        privateKey: settings.push.privateKey,
        subject,
      };
    }
    const keys = webpush.generateVAPIDKeys();
    const push: PushVapid = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: DEFAULT_SUBJECT,
    };
    await writeJsonFile(SETTINGS_FILE, { ...settings, push });
    return push;
  });
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  configured = vapid;
  return vapid;
}

export async function getPublicKey(): Promise<string> {
  return (await getVapid()).publicKey;
}

export async function addSubscription(sub: webpush.PushSubscription): Promise<void> {
  await withFileLock(PUSH_SUBSCRIPTIONS_FILE, async () => {
    const store = await readJsonFile<SubStore>(PUSH_SUBSCRIPTIONS_FILE, { subscriptions: [] });
    if (!store.subscriptions.some((s) => s.endpoint === sub.endpoint)) {
      store.subscriptions.push(sub);
      await writeJsonFile(PUSH_SUBSCRIPTIONS_FILE, store);
    }
  });
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await withFileLock(PUSH_SUBSCRIPTIONS_FILE, async () => {
    const store = await readJsonFile<SubStore>(PUSH_SUBSCRIPTIONS_FILE, { subscriptions: [] });
    const next = store.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (next.length !== store.subscriptions.length) {
      await writeJsonFile(PUSH_SUBSCRIPTIONS_FILE, { subscriptions: next });
    }
  });
}

/**
 * Send a notification to every stored subscription. Subscriptions the push
 * service reports as gone (404/410) are pruned. Fire-and-forget friendly:
 * never throws — returns counts.
 */
export async function sendPushNotification(
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  try {
    await getVapid();
  } catch {
    return { sent: 0, pruned: 0 };
  }
  const store = await readJsonFile<SubStore>(PUSH_SUBSCRIPTIONS_FILE, { subscriptions: [] });
  if (store.subscriptions.length === 0) return { sent: 0, pruned: 0 };

  const body = JSON.stringify(payload);
  const dead: string[] = [];
  let sent = 0;

  await Promise.all(
    store.subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body);
        sent++;
      } catch (e) {
        const err = e as { statusCode?: number; body?: string; message?: string };
        const code = err?.statusCode;
        if (code === 404 || code === 410) {
          dead.push(sub.endpoint);
        } else {
          // Don't swallow other failures silently — e.g. Apple returns 403
          // BadJwtToken for a malformed VAPID subject. Log host + reason so the
          // cause is diagnosable without re-instrumenting.
          let host = sub.endpoint;
          try { host = new URL(sub.endpoint).host; } catch { /* keep raw */ }
          console.error(`[push] send failed (${code ?? '?'}) to ${host}: ${err?.body || err?.message || 'unknown'}`);
        }
      }
    }),
  );

  if (dead.length) {
    await withFileLock(PUSH_SUBSCRIPTIONS_FILE, async () => {
      const cur = await readJsonFile<SubStore>(PUSH_SUBSCRIPTIONS_FILE, { subscriptions: [] });
      await writeJsonFile(PUSH_SUBSCRIPTIONS_FILE, {
        subscriptions: cur.subscriptions.filter((s) => !dead.includes(s.endpoint)),
      });
    });
  }

  return { sent, pruned: dead.length };
}
