import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    wsServer:       'src/lib/wsServer.ts',
    auth:           'src/lib/auth.ts',
    scheduledTasks: 'packages/feature/agent/src/server/scheduledTasks.ts',
    // The always-on Telegram listener (telegram-chat §5) — started by the custom
    // server so the bot answers after a restart without anyone opening Settings.
    telegramChat: 'packages/feature/agent/src/server/lib/telegramChatBoot.ts',
  },
  outDir: 'dist',
  format: 'esm',
  target: 'node20',
  platform: 'node',
  splitting: true,
  clean: true,
  // Keep node_modules external — don't bundle dependencies.
  // BUT inline @cockpit/* workspace packages: they're not published to npm,
  // so leaving them as external `import` references in dist/*.mjs would crash
  // at user runtime when wsServer / scheduledTasks dynamically resolve them
  // against the (non-existent) `node_modules/@cockpit/*`. Inlining at bundle
  // time mirrors what Next.js's `transpilePackages` does for `.next-prod/`.
  external: [/node_modules/],
  noExternal: [/^@cockpit\//],
});
