/**
 * Authentication state.
 *
 * One account, created by hand in the Supabase dashboard — there is no sign-up path here
 * on purpose. What the app needs from auth is a session whose JWT satisfies the Row Level
 * Security policies in `supabase/schema.sql`; issuing new identities is not part of that.
 *
 * Two behaviours worth stating:
 *
 * - **Unconfigured means open.** With no Supabase credentials the store reports
 *   `signed-in` as a local user. The alternative is a login wall in front of a database
 *   that does not exist, which locks a fresh clone (and the test suite) out of its own
 *   app. Persistence falls back to IndexedDB in exactly the same case, so the two agree.
 * - **The session is restored before the app renders.** `status` starts as `loading` and
 *   `initialize()` resolves it, so a reload does not flash the login page at someone who
 *   is already signed in.
 */

import { create } from 'zustand';

import { isSupabaseConfigured, supabase } from '../lib/supabase.js';

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

/** Stand-in id used when Supabase is not configured, so callers always have one. */
export const LOCAL_USER_ID = 'local';

export interface AuthState {
  status: AuthStatus;
  userId: string | null;
  email: string | null;
  /** Message from the last failed sign-in, cleared on the next attempt. */
  error: string | null;
  /** True while a sign-in request is in flight, so the button can disable itself. */
  busy: boolean;
  /** False when running without credentials — the UI says so rather than pretending. */
  configured: boolean;

  initialize: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  userId: null,
  email: null,
  error: null,
  busy: false,
  configured: isSupabaseConfigured(),

  initialize: async () => {
    if (!isSupabaseConfigured()) {
      set({ status: 'signed-in', userId: LOCAL_USER_ID, email: null, configured: false });
      return;
    }

    const client = supabase();

    // Sign-out and token refresh can both happen without the app asking, so the
    // subscription — not the initial read — is what keeps `status` honest over time.
    client.auth.onAuthStateChange((_event, session) => {
      set(
        session?.user
          ? { status: 'signed-in', userId: session.user.id, email: session.user.email ?? null }
          : { status: 'signed-out', userId: null, email: null },
      );
    });

    try {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      const user = data.session?.user;
      set(
        user
          ? { status: 'signed-in', userId: user.id, email: user.email ?? null }
          : { status: 'signed-out', userId: null, email: null },
      );
    } catch {
      // A network failure here is not a failed login; it just means no session yet.
      set({ status: 'signed-out', userId: null, email: null });
    }
  },

  signIn: async (email, password) => {
    if (!isSupabaseConfigured()) {
      set({ error: 'Supabase is not configured. Add credentials to apps/ganttor/.env.local.' });
      return;
    }

    set({ busy: true, error: null });
    try {
      const { data, error } = await supabase().auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) {
        set({ busy: false, error: friendlyAuthError(error.message) });
        return;
      }
      const user = data.user;
      set({
        busy: false,
        error: null,
        status: 'signed-in',
        userId: user?.id ?? null,
        email: user?.email ?? null,
      });
    } catch (cause) {
      set({
        busy: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  },

  signOut: async () => {
    if (isSupabaseConfigured()) {
      try {
        await supabase().auth.signOut();
      } catch {
        // Clearing local state matters more than the server round-trip succeeding.
      }
    }
    set({ status: 'signed-out', userId: null, email: null, error: null });
  },
}));

/**
 * Supabase returns one message for a wrong password and an unknown email alike, which is
 * correct — distinguishing them tells an attacker which half they got right. But the
 * unconfirmed-email case is a real setup mistake with a real fix, so it gets named.
 */
function friendlyAuthError(message: string): string {
  if (/email not confirmed/i.test(message)) {
    return 'That account has not been confirmed. In the Supabase dashboard, open Authentication → Users and confirm it.';
  }
  if (/invalid login credentials/i.test(message)) {
    return 'That email and password do not match an account.';
  }
  return message;
}
