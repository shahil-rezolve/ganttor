/**
 * The Supabase client.
 *
 * Created lazily and only when both environment variables are present. Two reasons that
 * matters rather than just calling `createClient` at module scope:
 *
 * 1. **The test suite has no Supabase.** `App.test.tsx` drives the real store against a
 *    real (fake) IndexedDB. Constructing a client with an empty URL throws at import
 *    time, which would take the whole suite down before a single test ran.
 * 2. **A missing `.env` should degrade, not crash.** `isSupabaseConfigured()` is the
 *    switch the persistence layer reads to choose its backend, so a fresh clone with no
 *    credentials still runs — it just saves locally until the keys are filled in.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True when both credentials are present, so the Supabase backend can be used. */
export function isSupabaseConfigured(): boolean {
  return Boolean(url && anonKey);
}

let client: SupabaseClient | null = null;

/**
 * The shared client.
 *
 * Throws when unconfigured rather than returning null: every caller is already behind an
 * `isSupabaseConfigured()` check, so reaching here without credentials is a bug worth
 * hearing about instead of a silent no-op that looks like a failed save.
 */
export function supabase(): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in apps/ganttor/.env.local',
    );
  }
  client ??= createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // The app is a single page with no OAuth redirect, so there is never a session to
      // recover from the URL — and looking for one only risks eating a query string.
      detectSessionInUrl: false,
    },
  });
  return client;
}
