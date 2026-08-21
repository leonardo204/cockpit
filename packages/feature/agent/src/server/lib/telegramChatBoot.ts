// packages/feature/agent/src/server/lib/telegramChatBoot.ts
//
// THE LISTENER'S ENTRY POINT AT BOOT (telegram-chat §5).
//
// Two-way chat means the user speaks FIRST, so there is nothing inside the app
// to start the loop the way a pending approval used to. If it only started when
// Settings were saved, the bot would go deaf after every restart — and the whole
// point of the feature is that it answers while the app sits untouched.
//
// So server.mjs calls this once, right after the scheduled-task manager is up.
// It is a separate module (rather than a line in scheduledTasks.ts) because the
// custom server loads it through the Node ESM loader while the API routes load
// the same code through the Next bundle: two module realms, one loop, and the
// bridge's globalThis-pinned state is what keeps it one. Its own tsup entry
// exists for the prod path (`dist/telegramChat.mjs`).
//
// Never throws: a broken Telegram config must not stop a server from booting.

import { getStore } from '../engines/naby';
import { isTelegramReady, readTelegramConfig } from './telegram';
import {
  ensureListener,
  kickTelegramListener,
  onTelegramListenerChange,
  registerTelegramCommands,
  telegramListenerDiagnostics,
  type TelegramListenerDiagnostics,
} from './telegramEscalation';

/** Start the always-on Telegram listener when the config can chat. Idempotent —
 *  `ensureListener` returns immediately when a loop already runs. */
export function startTelegramChat(): void {
  try {
    const store = getStore();
    const cfg = readTelegramConfig(store);
    if (!isTelegramReady(cfg)) {
      console.log('[telegram] chat listener not started: Telegram is off or unconfigured');
      return;
    }
    void registerTelegramCommands(store);
    ensureListener(store);
    console.log('[telegram] chat listener started');
  } catch (e) {
    console.warn('[telegram] chat listener failed to start:', e);
  }
}

// -- the control surface the Electron main process drives ---------------------
//
// WHY IT IS HERE AND NOT IMPORTED DIRECTLY. `electron/next-server.ts` already
// reaches the listener through exactly one specifier — `dist/telegramChat.mjs`,
// this file's tsup entry — and that is deliberate: the built entries share their
// chunks, so the bridge's state resolves to ONE instance across the Next bundle
// and the main process. A second import path (or a second bundling of the
// TypeScript source) would hand the main process a second bridge, and a second
// getUpdates loop on one bot token is the 409 the spec calls out. So everything
// Electron needs is added as an export HERE, and the main process keeps holding
// the single reference it already had.
//
// All three never throw: the caller is a power event handler, and a broken
// Telegram config must not take a `resume` listener down with it.

/**
 * The machine came back — a `resume` from sleep, a screen unlock, a login
 * session becoming active again. Cut the poll that has been talking to a socket
 * that no longer exists, so the channel is live on the next tick instead of
 * after the wall clock plus a back-off.
 */
export function wakeTelegramChat(reason: string): void {
  try {
    const outcome = kickTelegramListener(getStore());
    // Logged including 'idle': "nothing happened on resume" is itself the answer
    // when a report says the bot was deaf after a wake, and silence here would
    // leave that unanswerable.
    console.log(`[telegram] wake (${reason}): ${outcome}`);
  } catch (e) {
    console.warn(`[telegram] wake (${reason}) failed:`, e);
  }
}

/**
 * Watch the listener start and stop. The Electron main process holds a
 * `prevent-app-suspension` power-save blocker for exactly as long as a loop is
 * alive; this is how it learns. Returns an unsubscribe, and fires immediately
 * with the current state.
 */
export function observeTelegramChat(cb: (running: boolean) => void): () => void {
  try {
    return onTelegramListenerChange(cb);
  } catch (e) {
    console.warn('[telegram] listener observer not attached:', e);
    return () => {};
  }
}

/** The listener's own health, for whoever is asking why the bot went quiet. */
export function telegramChatDiagnostics(): TelegramListenerDiagnostics | undefined {
  try {
    return telegramListenerDiagnostics();
  } catch {
    return undefined;
  }
}
