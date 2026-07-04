// Central API client for the Supabase Edge Function backend. Every request carries the
// anon key (public by design). All helpers are NULL-SAFE on failure so the app degrades
// gracefully exactly like the old fetch-returns-null behaviour — the disruption loop never
// depends on the network being up (PRD offline-tolerance).
import type { Seed, Day, Hall, Session, Slot, Role, Person } from './types';
import { getAccessToken, getSession, setSession, clearSession } from './session';

// Fallbacks let the app build/deploy anywhere with zero env setup. Both values are
// PUBLIC by design (the anon key ships in every Supabase frontend; the DB is RLS-locked
// and all privileged work happens in Edge Functions with the service role).
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? 'https://mdurqgekkmqewniuujfb.supabase.co';
export const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kdXJxZ2Vra21xZXduaXV1amZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwODkzMzAsImV4cCI6MjA5ODY2NTMzMH0.iwHyL3GEeIIK3_pLEjjcAFkWK335zSQarFVN2s2A1UE';

// Base for every function route, e.g. `${API_BASE}/conferences`.
export const API_BASE = `${SUPABASE_URL}/functions/v1/api`;

// The apikey header is ALWAYS the anon key (Supabase gateway requirement). Authorization
// carries the logged-in user's access token when present, else the anon key so public
// routes keep working exactly as before.
function headers(): Record<string, string> {
  const token = getAccessToken() ?? ANON_KEY;
  return {
    'content-type': 'application/json',
    apikey: ANON_KEY,
    Authorization: `Bearer ${token}`,
  };
}

// One-shot refresh_token grant against Supabase Auth. Updates storage on success and returns
// true; on failure clears the session and returns false. In-flight de-duped so a burst of
// parallel 401s triggers a single refresh.
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const current = getSession();
    if (!current?.refresh_token) return false;
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: current.refresh_token }),
      });
      if (!r.ok) { clearSession(); return false; }
      const data = (await r.json()) as { access_token?: string; refresh_token?: string };
      if (!data.access_token || !data.refresh_token) { clearSession(); return false; }
      setSession({ access_token: data.access_token, refresh_token: data.refresh_token, email: current.email });
      return true;
    } catch {
      // Network blip — do NOT clear the session (offline tolerance); the caller returns null.
      return false;
    }
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

// After a failed refresh (expired/invalid session) send the user to the login screen.
function bounceToLogin(): void {
  clearSession();
  if (typeof window !== 'undefined' && window.location.hash !== '#/login') {
    window.location.hash = '#/login';
  }
}

// GET → parsed JSON or null on any failure (offline, non-2xx, bad JSON). On 401 attempts ONE
// silent refresh + retry; if that fails the session is cleared and we hard-navigate to #/login.
export async function apiGet<T>(path: string): Promise<T | null> {
  try {
    let r = await fetch(`${API_BASE}${path}`, { headers: headers() });
    if (r.status === 401 && getSession()) {
      if (await refreshSession()) {
        r = await fetch(`${API_BASE}${path}`, { headers: headers() });
      } else {
        bounceToLogin();
        return null;
      }
    }
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// POST → parsed JSON or null on any failure. Same 401 → refresh → retry once behaviour as GET.
export async function apiPost<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const payload = JSON.stringify(body ?? {});
    let r = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: headers(), body: payload });
    if (r.status === 401 && getSession()) {
      if (await refreshSession()) {
        r = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: headers(), body: payload });
      } else {
        bounceToLogin();
        return null;
      }
    }
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// ---- public link builders (UI hrefs) — absolute function URLs per the contract ----
export const publicLinks = {
  agendaJson: (confId: string) => `${API_BASE}/c/${confId}/public/agenda.json`,
  agendaIcs: (confId: string) => `${API_BASE}/c/${confId}/ics/agenda.ics`,
  personIcs: (confId: string, personId: string) => `${API_BASE}/c/${confId}/ics/person/${personId}.ics`,
  printDay: (confId: string, date: string) => `${API_BASE}/c/${confId}/print/day/${date}`,
};

// ---- auth: types shared with the session/auth layer ----
export type MembershipRole = 'secretariat' | 'chair' | 'speaker' | 'attendee';

export interface Membership {
  id: string;
  conference_id: string;
  conference_name: string;
  role: MembershipRole | string;
  person_id: string | null;
}

export interface MeUser { id: string; email: string; name: string; is_admin: boolean; }
export interface MeResponse { user: MeUser; memberships: Membership[]; }

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  user?: { id: string; email: string };
}

// Direct Supabase Auth password grant — plain fetch, distinguishes bad credentials (400) from
// an offline/other failure so the login screen can show a friendly message.
export type LoginResult =
  | { ok: true; token: TokenResponse }
  | { ok: false; reason: 'credentials' | 'offline' };

export async function loginRequest(email: string, password: string): Promise<LoginResult> {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (r.ok) {
      const token = (await r.json()) as TokenResponse;
      if (token?.access_token && token?.refresh_token) return { ok: true, token };
      return { ok: false, reason: 'credentials' };
    }
    if (r.status === 400 || r.status === 401) return { ok: false, reason: 'credentials' };
    return { ok: false, reason: 'offline' };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

// GET /me — the signed-in user + their memberships. Null when logged out (401) or offline.
export async function getMe(): Promise<MeResponse | null> {
  return apiGet('/me');
}

export async function changePassword(password: string): Promise<{ ok: boolean } | null> {
  return apiPost('/auth/change-password', { password });
}

// ---- admin endpoints (all require an admin session; server enforces 403) ----
export interface AdminUser {
  user_id: string;
  email: string;
  name: string;
  is_admin: boolean;
  created_at: string;
  memberships: Membership[];
}

export async function listAdminUsers(): Promise<{ users: AdminUser[] } | null> {
  return apiGet('/admin/users');
}

export async function createAdminUser(body: {
  email: string; password: string; name: string; is_admin?: boolean;
}): Promise<{ ok: boolean; user?: AdminUser } | null> {
  return apiPost('/admin/users', body);
}

// Distinguishes 409 (email already in use) from other failures for a clear message.
export type CreateUserResult =
  | { ok: true; user?: AdminUser }
  | { ok: false; reason: 'exists' | 'offline' };

export async function createAdminUserDetailed(body: {
  email: string; password: string; name: string; is_admin?: boolean;
}): Promise<CreateUserResult> {
  try {
    let r = await fetch(`${API_BASE}/admin/users`, {
      method: 'POST', headers: headers(), body: JSON.stringify(body),
    });
    if (r.status === 401 && getSession()) {
      if (await refreshSession()) {
        r = await fetch(`${API_BASE}/admin/users`, {
          method: 'POST', headers: headers(), body: JSON.stringify(body),
        });
      } else {
        bounceToLogin();
        return { ok: false, reason: 'offline' };
      }
    }
    if (r.ok) {
      const data = (await r.json()) as { ok?: boolean; user?: AdminUser };
      return { ok: true, user: data.user };
    }
    if (r.status === 409) return { ok: false, reason: 'exists' };
    return { ok: false, reason: 'offline' };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

export async function setUserPassword(userId: string, password: string): Promise<{ ok: boolean } | null> {
  return apiPost(`/admin/users/${encodeURIComponent(userId)}/password`, { password });
}

export async function deleteUser(userId: string): Promise<{ ok: boolean } | null> {
  return apiPost(`/admin/users/${encodeURIComponent(userId)}/delete`, {});
}

export async function addMembership(userId: string, body: {
  conference_id: string; role: string; person_id?: string;
}): Promise<{ ok: boolean; membership?: Membership } | null> {
  return apiPost(`/admin/users/${encodeURIComponent(userId)}/memberships`, body);
}

export async function deleteMembership(membershipId: string): Promise<{ ok: boolean } | null> {
  return apiPost(`/admin/memberships/${encodeURIComponent(membershipId)}/delete`, {});
}

// ---- conference list / creation ----
export interface ConferenceSummary {
  id: string;
  slug: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  sample: boolean;
  created_at: string;
}

export async function listConferences(): Promise<{ conferences: ConferenceSummary[] } | null> {
  return apiGet('/conferences');
}

export async function createConference(body: {
  name: string; slug?: string; start_date?: string; end_date?: string;
}): Promise<{ conference: ConferenceSummary } | null> {
  return apiPost('/conferences', body);
}

// ---- agenda snapshot (same shapes as the old seed.json) ----
export interface AgendaSnapshot extends Seed {
  conference?: ConferenceSummary;
}

export async function getAgenda(confId: string): Promise<AgendaSnapshot | null> {
  return apiGet(`/c/${confId}/agenda`);
}

// ---- Claude API key settings ----
export async function getAnthropicKeyStatus(): Promise<{ present: boolean } | null> {
  return apiGet('/settings/anthropic-key');
}

export async function saveAnthropicKey(key: string): Promise<{ ok: boolean } | null> {
  return apiPost('/settings/anthropic-key', { key });
}

// ---- Claude availability (for the import wizard) ----
export async function getProseHealth(): Promise<{ available: boolean; model?: string } | null> {
  return apiGet('/prose/health');
}

// ---- import wizard: uploads ----
export interface UploadRow {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  status: string;
  created_at: string;
}

export async function signUpload(confId: string, body: { filename: string; mime: string; size: number }):
  Promise<{ uploadId: string; path: string; signedUrl: string } | null> {
  return apiPost(`/c/${confId}/uploads/sign`, body);
}

// Uploads the raw file bytes straight to the signed storage URL. No apikey header — the
// signed URL is self-authorizing. Returns true on a 2xx PUT. Null-safe like the rest.
export async function putSignedFile(signedUrl: string, mime: string, file: File): Promise<boolean> {
  try {
    const r = await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'content-type': mime, 'x-upsert': 'true' },
      body: file,
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function completeUpload(confId: string, uploadId: string):
  Promise<{ ok: boolean; upload?: UploadRow } | null> {
  return apiPost(`/c/${confId}/uploads/${uploadId}/complete`, {});
}

export async function listUploads(confId: string): Promise<{ uploads: UploadRow[] } | null> {
  return apiGet(`/c/${confId}/uploads`);
}

// ---- import wizard: processing / draft / commit ----
export interface ImportSummary {
  files: string[];
  days: number;
  halls: number;
  sessions: number;
  slots: number;
  people: number;
  resolvedRoles: number;
  unresolvedRoles: number;
  flags: string[];
}

// Processing is SLOW (1–3 min of Claude parsing per file). We do a raw fetch here rather
// than apiPost so we can distinguish the documented error codes (no_api_key / parse_failed)
// from a plain offline null. No client timeout — the long request is expected.
export type ProcessResult =
  | { ok: true; draftId?: string; summary?: ImportSummary }
  | { ok: false; error: 'no_api_key' | 'parse_failed' | 'offline' };

export async function processUpload(confId: string, uploadId: string): Promise<ProcessResult> {
  try {
    const r = await fetch(`${API_BASE}/c/${confId}/imports/process`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ uploadId }),
    });
    if (r.ok) {
      const data = (await r.json()) as { ok?: boolean; draftId?: string; summary?: ImportSummary };
      return { ok: true, draftId: data.draftId, summary: data.summary };
    }
    if (r.status === 503) return { ok: false, error: 'no_api_key' };
    if (r.status === 502) return { ok: false, error: 'parse_failed' };
    return { ok: false, error: 'parse_failed' };
  } catch {
    return { ok: false, error: 'offline' };
  }
}

export interface ImportDraft {
  id: string;
  status: string;
  summary: ImportSummary;
  data: {
    days?: Day[];
    halls?: Hall[];
    sessions?: Session[];
    slots?: Slot[];
    roles?: Role[];
    people?: Person[];
  };
}

export async function getImportDraft(confId: string): Promise<{ draft: ImportDraft | null } | null> {
  return apiGet(`/c/${confId}/imports/draft`);
}

export async function commitImport(confId: string, mode: 'replace' | 'append'):
  Promise<{ ok: boolean; counts?: Record<string, number> } | null> {
  return apiPost(`/c/${confId}/imports/commit`, { mode });
}

export async function discardImport(confId: string): Promise<{ ok: boolean } | null> {
  return apiPost(`/c/${confId}/imports/discard`, {});
}
