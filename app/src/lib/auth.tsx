// Session layer: owns login/logout and exposes the signed-in user + memberships (GET /me).
// Token storage itself lives in session.ts so api.ts can read/refresh it without importing
// this module (avoids a circular import). Null-safe throughout — an offline /me leaves the
// stored session in place and simply reports `me: null` until the next successful refresh().
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { loginRequest, getMe } from './api';
import type { MeResponse } from './api';
import { getSession, setSession, clearSession } from './session';

export type LoginOutcome = 'ok' | 'credentials' | 'offline';

interface AuthValue {
  me: MeResponse | null;
  loading: boolean;               // true during boot + while re-fetching /me
  email: string | null;           // the stored login email (available before /me returns)
  login: (email: string, password: string) => Promise<LoginOutcome>;
  logout: () => void;
  refresh: () => Promise<void>;   // re-fetch /me (e.g. after an admin grants a membership)
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(() => getSession()?.email ?? null);

  const refresh = useCallback(async () => {
    if (!getSession()) { setMe(null); setLoading(false); return; }
    setLoading(true);
    const res = await getMe();
    setMe(res);
    setLoading(false);
  }, []);

  // Boot: if a session is stored, fetch /me; otherwise we're logged out.
  useEffect(() => {
    let on = true;
    (async () => {
      if (!getSession()) { if (on) setLoading(false); return; }
      const res = await getMe();
      if (on) { setMe(res); setLoading(false); }
    })();
    return () => { on = false; };
  }, []);

  const login = useCallback(async (loginEmail: string, password: string): Promise<LoginOutcome> => {
    const res = await loginRequest(loginEmail, password);
    if (!res.ok) return res.reason;
    setSession({
      access_token: res.token.access_token,
      refresh_token: res.token.refresh_token,
      email: res.token.user?.email ?? loginEmail,
    });
    setEmail(res.token.user?.email ?? loginEmail);
    setLoading(true);
    const meRes = await getMe();
    setMe(meRes);
    setLoading(false);
    return 'ok';
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setMe(null);
    setEmail(null);
    setLoading(false);
    if (window.location.hash !== '#/login') window.location.hash = '#/login';
  }, []);

  return (
    <AuthContext.Provider value={{ me, loading, email, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}

// A strong, human-shareable password: 14 chars, mixed classes, no lookalike characters.
export function generatePassword(len = 14): string {
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';   // no I, L, O
  const lower = 'abcdefghijkmnpqrstuvwxyz';   // no l, o
  const digits = '23456789';                  // no 0, 1
  const symbols = '!@#$%*?';
  const all = upper + lower + digits + symbols;
  const rnd = (n: number) => {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % n;
  };
  // Guarantee at least one of each class, then fill the rest.
  const chars = [upper[rnd(upper.length)], lower[rnd(lower.length)], digits[rnd(digits.length)], symbols[rnd(symbols.length)]];
  while (chars.length < len) chars.push(all[rnd(all.length)]);
  // Fisher–Yates shuffle so the guaranteed chars aren't always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
