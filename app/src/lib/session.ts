// Tiny token store shared by api.ts (reads the access token for the Authorization header +
// does the silent refresh) and auth.tsx (owns the login/logout lifecycle). Kept dependency-free
// so both can import it without a circular reference. Persisted in localStorage under 'ap_session'.

const KEY = 'ap_session';

export interface StoredSession {
  access_token: string;
  refresh_token: string;
  email: string;
}

export function getSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<StoredSession>;
    if (s && typeof s.access_token === 'string' && typeof s.refresh_token === 'string') {
      return { access_token: s.access_token, refresh_token: s.refresh_token, email: s.email ?? '' };
    }
    return null;
  } catch {
    return null;
  }
}

export function setSession(s: StoredSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore storage failures (private mode etc.) — the app still works for this tab.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

// The access token to put on Authorization, or null when logged out (callers fall back to anon).
export function getAccessToken(): string | null {
  return getSession()?.access_token ?? null;
}
