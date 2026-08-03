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
import { ensureListener, registerTelegramCommands } from './telegramEscalation';

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
