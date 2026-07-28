import { defineConfig } from 'vitest/config';

/**
 * There was no config here at all, so vitest ran on defaults — including a
 * default of "inherit the developer's environment", which is how the suite came
 * to write sessions into the real `~/.naby/app.db`. See vitest.setup.ts.
 */
export default defineConfig({
  test: {
    // Runs before any test module is imported, which matters: the store reads
    // NABY_DB_PATH when it is first constructed, and a module-level store would
    // otherwise already be pointing at the real database by the time a
    // beforeAll() could redirect it.
    setupFiles: ['./vitest.setup.ts'],
  },
});
