import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    // `@/*` → `src/*`. Declared here rather than in a vitest-only block: because the
    // config comes from `vitest/config`, one entry serves the dev server, the production
    // build, and the test run, so they cannot drift apart.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5273, open: false },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    /*
     * The suite drives the real store against a fake IndexedDB and expects the *local*
     * backend, so it must never see Supabase credentials. Without this, a developer's
     * own `.env.local` leaks into the test environment, `isSupabaseConfigured()` turns
     * true, and every test that renders the workspace gets the sign-in page instead —
     * 21 failures that look like app regressions and are really config bleed.
     */
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
  },
});
