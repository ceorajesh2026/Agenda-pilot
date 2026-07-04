// AgendaPilot — credential-based access control (Phase C).
//
// Users authenticate with email+password via Supabase Auth. An admin manages
// users and assigns them to conferences with roles (memberships). This module
// owns the auth helpers + the auth/admin endpoints. index.ts weaves the guards
// into its existing routing.
//
// The Edge Function keeps verify_jwt=false (public feeds must stay public); we
// enforce auth in-code. The frontend always sends `apikey: <anon>` plus
// `Authorization: Bearer <user_jwt_or_anon>` — a Bearer equal to the anon key
// (or absent) is treated as unauthenticated.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Supabase injects SUPABASE_ANON_KEY into the edge runtime; fall back to the
// project's known anon key so a Bearer equal to it is always treated as
// unauthenticated even if the env var is missing.
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kdXJxZ2Vra21xZXduaXV1amZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwODkzMzAsImV4cCI6MjA5ODY2NTMzMH0.iwHyL3GEeIIK3_pLEjjcAFkWK335zSQarFVN2s2A1UE";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const now = () => new Date().toISOString();
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export type Membership = {
  id: string;
  conference_id: string;
  conference_name: string | null;
  role: string;
  person_id: string | null;
};
export type AuthUser = {
  id: string;
  email: string | null;
  name: string | null;
  is_admin: boolean;
  memberships: Membership[];
};

// Extract the bearer token, treating an absent token OR one equal to the anon
// key as "no user".
function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return null;
  const token = m[1].trim();
  if (!token || (ANON_KEY && token === ANON_KEY)) return null;
  return token;
}

// Resolve the authenticated user for this request (or null). Loads profile +
// memberships (with conference names). Per-request; nothing cached.
export async function getAuthUser(req: Request): Promise<AuthUser | null> {
  const token = bearerToken(req);
  if (!token) return null;

  // The service client can verify any user JWT via getUser(token).
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  const uid = data.user.id;

  const [{ data: profile }, { data: memRows }] = await Promise.all([
    admin.from("profiles").select("user_id,email,name,is_admin").eq("user_id", uid).maybeSingle(),
    admin.from("memberships")
      .select("id,conference_id,role,person_id,conferences(name)")
      .eq("user_id", uid),
  ]);

  const memberships: Membership[] = (memRows ?? []).map((m: any) => ({
    id: m.id,
    conference_id: m.conference_id,
    conference_name: m.conferences?.name ?? null,
    role: m.role,
    person_id: m.person_id ?? null,
  }));

  return {
    id: uid,
    email: profile?.email ?? data.user.email ?? null,
    name: profile?.name ?? null,
    is_admin: !!profile?.is_admin,
    memberships,
  };
}

// Guards: each returns { user } on success or { resp } (a Response) to short-circuit.
export type Guard = { user: AuthUser; resp?: undefined } | { user?: undefined; resp: Response };

export async function requireAuth(req: Request): Promise<Guard> {
  const user = await getAuthUser(req);
  if (!user) return { resp: json({ error: "unauthorized" }, 401) };
  return { user };
}

export async function requireAdmin(req: Request): Promise<Guard> {
  const g = await requireAuth(req);
  if (g.resp) return g;
  if (!g.user.is_admin) return { resp: json({ error: "forbidden" }, 403) };
  return { user: g.user };
}

// Member (or admin) of a conference. `roles`, when given, restricts to those
// membership roles. Admin always passes.
export async function requireMember(req: Request, confId: string, roles?: string[]): Promise<Guard> {
  const g = await requireAuth(req);
  if (g.resp) return g;
  const user = g.user;
  if (user.is_admin) return { user };
  const mem = user.memberships.find((m) => m.conference_id === confId);
  if (!mem) return { resp: json({ error: "forbidden" }, 403) };
  if (roles && roles.length && !roles.includes(mem.role)) return { resp: json({ error: "forbidden" }, 403) };
  return { user };
}

// ---------------------------------------------------------------------------
// router — returns null if the path is not an auth/admin-user route, so
// index.ts continues with its own routing.
// ---------------------------------------------------------------------------
export async function handleAuth(
  req: Request, p: string, method: string, readBody: () => Promise<any>,
): Promise<Response | null> {
  // ---- PUBLIC: bootstrap the first admin (only while zero admins exist) ----
  if (p === "/auth/bootstrap-admin" && method === "POST") {
    const { count } = await admin.from("profiles").select("user_id", { count: "exact", head: true }).eq("is_admin", true);
    if ((count ?? 0) > 0) return json({ error: "already_bootstrapped" }, 403);

    const b = await readBody();
    const email = String(b?.email || "").trim().toLowerCase();
    const password = String(b?.password || "");
    const name = b?.name != null ? String(b.name) : null;
    if (!email || !password) return json({ error: "email_password_required" }, 400);

    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data?.user) {
      return json({ error: "create_failed", detail: created.error?.message ?? "no user" }, 400);
    }
    const uid = created.data.user.id;
    const { error: pErr } = await admin.from("profiles").insert({ user_id: uid, email, name, is_admin: true });
    if (pErr) {
      // roll back the auth user so bootstrap can be retried cleanly
      await admin.auth.admin.deleteUser(uid);
      return json({ error: "profile_failed", detail: pErr.message }, 500);
    }
    return json({ ok: true, user_id: uid });
  }

  // ---- AUTH: current user ----
  if (p === "/me" && method === "GET") {
    const g = await requireAuth(req);
    if (g.resp) return g.resp;
    const u = g.user;
    return json({
      user: { id: u.id, email: u.email, name: u.name, is_admin: u.is_admin },
      memberships: u.memberships,
    });
  }

  // ---- AUTH: change own password ----
  if (p === "/auth/change-password" && method === "POST") {
    const g = await requireAuth(req);
    if (g.resp) return g.resp;
    const b = await readBody();
    const password = String(b?.password || "");
    if (!password) return json({ error: "password_required" }, 400);
    const upd = await admin.auth.admin.updateUserById(g.user.id, { password });
    if (upd.error) return json({ error: "update_failed", detail: upd.error.message }, 400);
    return json({ ok: true });
  }

  // ---- ADMIN: user management ----
  if (p === "/admin/users" && method === "GET") {
    const g = await requireAdmin(req);
    if (g.resp) return g.resp;
    const { data: profiles } = await admin.from("profiles")
      .select("user_id,email,name,is_admin,created_at").order("created_at", { ascending: true });
    const { data: memRows } = await admin.from("memberships")
      .select("id,user_id,conference_id,role,person_id,conferences(name)");
    const byUser = new Map<string, Membership[]>();
    for (const m of (memRows ?? []) as any[]) {
      const arr = byUser.get(m.user_id) ?? [];
      arr.push({
        id: m.id, conference_id: m.conference_id,
        conference_name: m.conferences?.name ?? null, role: m.role, person_id: m.person_id ?? null,
      });
      byUser.set(m.user_id, arr);
    }
    const users = (profiles ?? []).map((pr: any) => ({
      user_id: pr.user_id, email: pr.email, name: pr.name, is_admin: pr.is_admin,
      created_at: pr.created_at, memberships: byUser.get(pr.user_id) ?? [],
    }));
    return json({ users });
  }

  if (p === "/admin/users" && method === "POST") {
    const g = await requireAdmin(req);
    if (g.resp) return g.resp;
    const b = await readBody();
    const email = String(b?.email || "").trim().toLowerCase();
    const password = String(b?.password || "");
    const name = b?.name != null ? String(b.name) : null;
    const isAdmin = !!b?.is_admin;
    if (!email || !password) return json({ error: "email_password_required" }, 400);

    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data?.user) {
      const msg = created.error?.message ?? "";
      // duplicate email -> 409
      if (/registered|already|exists|duplicate/i.test(msg)) return json({ error: "email_exists" }, 409);
      return json({ error: "create_failed", detail: msg }, 400);
    }
    const uid = created.data.user.id;
    const { error: pErr } = await admin.from("profiles").insert({ user_id: uid, email, name, is_admin: isAdmin });
    if (pErr) {
      await admin.auth.admin.deleteUser(uid);
      return json({ error: "profile_failed", detail: pErr.message }, 500);
    }
    return json({ ok: true, user: { user_id: uid, email, name, is_admin: isAdmin } });
  }

  // /admin/users/:userId/delete
  if (p.startsWith("/admin/users/") && p.endsWith("/delete") && method === "POST") {
    const g = await requireAdmin(req);
    if (g.resp) return g.resp;
    const userId = decodeURIComponent(p.slice("/admin/users/".length, -"/delete".length));
    if (!userId) return json({ error: "user_required" }, 400);
    if (userId === g.user.id) return json({ error: "cannot_delete_self" }, 400);
    const del = await admin.auth.admin.deleteUser(userId); // cascades profile + memberships
    if (del.error) return json({ error: "delete_failed", detail: del.error.message }, 400);
    return json({ ok: true });
  }

  // /admin/users/:userId/password
  if (p.startsWith("/admin/users/") && p.endsWith("/password") && method === "POST") {
    const g = await requireAdmin(req);
    if (g.resp) return g.resp;
    const userId = decodeURIComponent(p.slice("/admin/users/".length, -"/password".length));
    if (!userId) return json({ error: "user_required" }, 400);
    const b = await readBody();
    const password = String(b?.password || "");
    if (!password) return json({ error: "password_required" }, 400);
    const upd = await admin.auth.admin.updateUserById(userId, { password });
    if (upd.error) return json({ error: "update_failed", detail: upd.error.message }, 400);
    return json({ ok: true });
  }

  // /admin/users/:userId/memberships (upsert on unique(user_id,conference_id))
  if (p.startsWith("/admin/users/") && p.endsWith("/memberships") && method === "POST") {
    const g = await requireAdmin(req);
    if (g.resp) return g.resp;
    const userId = decodeURIComponent(p.slice("/admin/users/".length, -"/memberships".length));
    if (!userId) return json({ error: "user_required" }, 400);
    const b = await readBody();
    const conferenceId = String(b?.conference_id || "");
    const role = String(b?.role || "");
    const personId = b?.person_id != null ? String(b.person_id) : null;
    if (!conferenceId || !role) return json({ error: "conference_and_role_required" }, 400);
    const { data, error } = await admin.from("memberships")
      .upsert({ user_id: userId, conference_id: conferenceId, role, person_id: personId },
        { onConflict: "user_id,conference_id" })
      .select("id,conference_id,role,person_id").single();
    if (error) return json({ error: "membership_failed", detail: error.message }, 400);
    return json({ ok: true, membership: data });
  }

  // /admin/memberships/:membershipId/delete
  if (p.startsWith("/admin/memberships/") && p.endsWith("/delete") && method === "POST") {
    const g = await requireAdmin(req);
    if (g.resp) return g.resp;
    const membershipId = decodeURIComponent(p.slice("/admin/memberships/".length, -"/delete".length));
    if (!membershipId) return json({ error: "membership_required" }, 400);
    const { error } = await admin.from("memberships").delete().eq("id", membershipId);
    if (error) return json({ error: "delete_failed", detail: error.message }, 400);
    return json({ ok: true });
  }

  return null; // not an auth route
}
