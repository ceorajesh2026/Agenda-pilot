// Login screen: a centered card with the AgendaPilot wordmark, a short tagline, and the
// email + password form. No self-registration — the admin creates accounts. On success the
// AuthProvider stores the session and the app re-renders into the landing page.
import { useState } from 'react';
import { useAuth } from '../lib/auth';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError('');
    const outcome = await login(email.trim(), password);
    setBusy(false);
    if (outcome === 'ok') {
      window.location.hash = '#/';
    } else if (outcome === 'credentials') {
      setError("That email or password doesn't match. Please try again.");
    } else {
      setError("We couldn't reach the server. Check your connection and try again.");
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card card" onSubmit={submit}>
        <div className="login-logo">AgendaPilot</div>
        <div className="login-tag">Run your conference agenda — disruptions handled in minutes</div>

        <div className="frow col" style={{ marginTop: 18 }}>
          <label>Email</label>
          <input type="email" value={email} autoComplete="username" autoFocus
            onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={{ width: '100%' }} />
        </div>
        <div className="frow col">
          <label>Password</label>
          <input type="password" value={password} autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} placeholder="Your password" style={{ width: '100%' }} />
        </div>

        {error && <div className="sc-body" style={{ color: 'var(--red)', margin: '4px 0 8px' }}>{error}</div>}

        <button className="btn ok full" type="submit" disabled={busy || !email.trim() || !password} style={{ marginTop: 8 }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="muted" style={{ fontSize: 11.5, marginTop: 14, textAlign: 'center' }}>
          Accounts are created by your organizer. Ask them if you need access.
        </p>
      </form>
    </div>
  );
}
