/**
 * The login page.
 *
 * Deliberately the whole screen rather than a modal over a blurred chart: there is
 * nothing behind it to look at, and a dialog would imply the app underneath is usable.
 *
 * No sign-up, no password reset, no "remember me". The account is created once in the
 * Supabase dashboard, and the session is already persisted by the client — so every
 * control that is not "get me in" has been left out.
 */

import { useEffect, useRef, useState } from 'react';

import { useAuthStore } from '../store/useAuthStore.js';

export function LoginPage() {
  const signIn = useAuthStore((s) => s.signIn);
  const error = useAuthStore((s) => s.error);
  const busy = useAuthStore((s) => s.busy);
  const configured = useAuthStore((s) => s.configured);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy;

  return (
    <div className="ganttor-login" data-gantt-theme="dark">
      <form
        className="ganttor-login__card"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) void signIn(email, password);
        }}
      >
        <div className="ganttor-login__head">
          <span className="ganttor-login__mark">Ganttor</span>
          <h1 className="ganttor-login__title">Sign in</h1>
          <p className="ganttor-login__sub">
            Your projects are stored in Supabase and are only visible to this account.
          </p>
        </div>

        {!configured && (
          <div className="ganttor-notice" data-tone="warn">
            <span className="ganttor-notice__message">
              Supabase is not configured, so sign-in is disabled and projects save to this
              browser only. Copy <code>.env.example</code> to <code>.env.local</code> and add
              your project URL and anon key.
            </span>
          </div>
        )}

        {error && (
          <div className="ganttor-notice" data-tone="error" role="alert">
            <span className="ganttor-notice__message">{error}</span>
          </div>
        )}

        <label className="ganttor-field">
          <span className="ganttor-field__label">Email</span>
          <input
            ref={emailRef}
            className="ganttor-input ganttor-input--lg"
            type="email"
            name="email"
            autoComplete="username"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label className="ganttor-field">
          <span className="ganttor-field__label">Password</span>
          <input
            className="ganttor-input ganttor-input--lg"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        <button
          type="submit"
          className="ganttor-btn ganttor-btn--primary ganttor-btn--lg ganttor-login__submit"
          disabled={!canSubmit}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
