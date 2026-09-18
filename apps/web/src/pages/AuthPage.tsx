import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Logomark } from '../components/icons';

type Mode = 'signin' | 'signup';

export function AuthPage() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signin') await signIn(email, password);
      else await signUp(email, displayName, password);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Something went wrong. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="auth">
      <div className="auth-art">
        <div className="top">
          <Logomark />
          Meridian
        </div>
        <div>
          <h2>Your strategies, running while you sleep.</h2>
          <p className="lede">
            Connect a MetaTrader account, deploy a strategy to it, and watch what
            it actually does — not what a backtest hoped it would do.
          </p>
          <div className="auth-stats">
            <div className="auth-stat">
              <div className="v">28</div>
              <div className="l">Majors and minors</div>
            </div>
            <div className="auth-stat">
              <div className="v">MT5</div>
              <div className="l">Broker bridge</div>
            </div>
            <div className="auth-stat">
              <div className="v">100%</div>
              <div className="l">Runs on your machine</div>
            </div>
          </div>
        </div>
        <p className="dimmer" style={{ fontSize: '11.5px' }}>
          Nothing leaves your computer. Prices, credentials and the AI model all
          stay local.
        </p>
      </div>

      <div className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <h1>{mode === 'signin' ? 'Welcome back' : 'Create your account'}</h1>
          <p className="sub">
            {mode === 'signin'
              ? 'Sign in to reach your accounts and strategies.'
              : 'The first account on a fresh install becomes the owner.'}
          </p>

          <div className="seg" role="tablist">
            <div
              role="tab"
              aria-selected={mode === 'signin'}
              tabIndex={0}
              className={mode === 'signin' ? 'on' : ''}
              onClick={() => { setMode('signin'); setError(null); }}
              onKeyDown={(e) => e.key === 'Enter' && setMode('signin')}
            >
              Sign in
            </div>
            <div
              role="tab"
              aria-selected={mode === 'signup'}
              tabIndex={0}
              className={mode === 'signup' ? 'on' : ''}
              onClick={() => { setMode('signup'); setError(null); }}
              onKeyDown={(e) => e.key === 'Enter' && setMode('signup')}
            >
              Create account
            </div>
          </div>

          {error && <div className="alert err">{error}</div>}

          {mode === 'signup' && (
            <div className="f">
              <label htmlFor="name">Your name</label>
              <input
                id="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
                required
              />
            </div>
          )}

          <div className="f">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </div>

          <div className="f">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={
                mode === 'signin' ? 'current-password' : 'new-password'
              }
              required
            />
            {mode === 'signup' && (
              <span className="hint">
                At least 10 characters. This password unlocks your stored broker
                credentials.
              </span>
            )}
          </div>

          <button className="btn btn-block mt16" disabled={busy}>
            {busy
              ? mode === 'signin' ? 'Signing in…' : 'Creating account…'
              : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>

          <div className="divider">Before you connect a broker</div>
          <p className="note">
            Use a demo account until backtest and live results have been checked
            against each other. Order execution is switched off in this build.
          </p>
        </form>
      </div>
    </div>
  );
}
