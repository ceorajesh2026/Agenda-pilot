// Admin dashboard — "Team & access". Admin-only (route-guarded in App.tsx). Lists every user
// with their memberships as chips, and lets an admin add people, grant/remove conference
// access, reset passwords, and remove users. Plain language throughout; reuses .card/.chip/.btn.
import { useEffect, useMemo, useState } from 'react';
import {
  listAdminUsers, createAdminUserDetailed, setUserPassword, deleteUser,
  addMembership, deleteMembership, listConferences, getAgenda,
} from '../lib/api';
import type { AdminUser, ConferenceSummary, Membership } from '../lib/api';
import { useAuth, generatePassword } from '../lib/auth';
import type { Person } from '../lib/types';

const ROLE_OPTIONS: { id: string; label: string }[] = [
  { id: 'secretariat', label: 'Secretariat' },
  { id: 'chair', label: 'Chair' },
  { id: 'speaker', label: 'Speaker' },
  { id: 'attendee', label: 'Attendee' },
];

const ROLE_LABEL: Record<string, string> = {
  secretariat: 'Secretariat', chair: 'Chair', speaker: 'Speaker', attendee: 'Attendee',
};

type LoadState = 'loading' | 'ready' | 'offline';

export default function AdminDash({ onBack }: { onBack: () => void }) {
  const { me } = useAuth();
  const [state, setState] = useState<LoadState>('loading');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [conferences, setConferences] = useState<ConferenceSummary[]>([]);
  const [adding, setAdding] = useState(false);

  const load = () => {
    setState('loading');
    Promise.all([listAdminUsers(), listConferences()]).then(([u, c]) => {
      if (u && Array.isArray(u.users)) {
        setUsers(u.users);
        setConferences(c && Array.isArray(c.conferences) ? c.conferences : []);
        setState('ready');
      } else {
        setState('offline');
      }
    });
  };
  useEffect(load, []);

  return (
    <div className="app">
      <header className="top">
        <button className="linkback" onClick={onBack} style={{ marginBottom: 0 }}>‹ All conferences</button>
        <h1 style={{ marginLeft: 4 }}>AgendaPilot</h1>
        <div className="sub">Team &amp; access</div>
      </header>

      {state === 'loading' && (
        <div className="landing-empty"><div className="spinner" /><p className="muted">Loading your team…</p></div>
      )}

      {state === 'offline' && (
        <div className="landing-empty">
          <div className="status-card amber" style={{ maxWidth: 520, margin: '0 auto', textAlign: 'left' }}>
            <div className="sc-title">Couldn't load the team</div>
            <div className="sc-body">The server isn't reachable right now. Please try again in a moment.</div>
            <div className="btnrow" style={{ marginTop: 12 }}>
              <button className="btn ok" onClick={load}>Try again</button>
            </div>
          </div>
        </div>
      )}

      {state === 'ready' && (
        <>
          <div className="btnrow" style={{ marginBottom: 14 }}>
            {!adding && <button className="btn ok" onClick={() => setAdding(true)}>＋ Add person</button>}
          </div>

          {adding && (
            <AddPersonPanel
              conferences={conferences}
              onCancel={() => setAdding(false)}
              onDone={() => { setAdding(false); load(); }}
            />
          )}

          <div className="section-title" style={{ marginTop: 4 }}>People ({users.length})</div>
          <div className="scroll" style={{ marginTop: 8 }}>
            <table className="difftab" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>Name</th><th>Email</th><th>Access</th><th>Added</th><th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRow
                    key={u.user_id}
                    user={u}
                    conferences={conferences}
                    selfUserId={me?.user.id ?? ''}
                    onChanged={load}
                  />
                ))}
                {users.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ padding: 14 }}>No people yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function UserRow({ user, conferences, selfUserId, onChanged }:
  { user: AdminUser; conferences: ConferenceSummary[]; selfUserId: string; onChanged: () => void }) {
  const [assigning, setAssigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const isSelf = user.user_id === selfUserId;

  const removeMembership = async (m: Membership) => {
    if (!window.confirm(`Remove ${user.name || user.email} from ${m.conference_name}?`)) return;
    setBusy(true);
    const res = await deleteMembership(m.id);
    setBusy(false);
    if (res?.ok) onChanged();
    else setNote("Couldn't remove that — please try again.");
  };

  const resetPassword = async () => {
    const pw = generatePassword();
    if (!window.confirm(`Set a new password for ${user.name || user.email}?\n\nNew password:\n${pw}\n\nCopy it now — it won't be shown again.`)) return;
    setBusy(true);
    const res = await setUserPassword(user.user_id, pw);
    setBusy(false);
    if (res?.ok) setNote(`New password set: ${pw} — share it securely.`);
    else setNote("Couldn't reset the password — please try again.");
  };

  const remove = async () => {
    if (isSelf) return;
    if (!window.confirm(`Remove ${user.name || user.email}? This deletes their account and all access.`)) return;
    setBusy(true);
    const res = await deleteUser(user.user_id);
    setBusy(false);
    if (res?.ok) onChanged();
    else setNote("Couldn't remove this person — please try again.");
  };

  return (
    <>
      <tr>
        <td>
          <strong>{user.name || '—'}</strong>{' '}
          {user.is_admin && <span className="chip info">Admin</span>}
        </td>
        <td className="muted">{user.email}</td>
        <td>
          {user.memberships.length === 0 && <span className="muted" style={{ fontSize: 12 }}>No conferences</span>}
          <div className="chiprow">
            {user.memberships.map((m) => (
              <span className="chip track" key={m.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {m.conference_name} · {ROLE_LABEL[m.role] ?? m.role}
                <button className="chip-x" title="Remove access" disabled={busy}
                  onClick={() => removeMembership(m)}>×</button>
              </span>
            ))}
          </div>
        </td>
        <td className="muted" style={{ fontSize: 12 }}>{fmtDate(user.created_at)}</td>
        <td>
          <div className="btnrow">
            <button className="btn sm" disabled={busy} onClick={() => setAssigning((v) => !v)}>Add to conference</button>
            <button className="btn sm" disabled={busy} onClick={resetPassword}>Reset password</button>
            <button className="btn sm bad" disabled={busy || isSelf}
              title={isSelf ? "You can't remove yourself" : ''} onClick={remove}>Remove</button>
          </div>
        </td>
      </tr>
      {note && (
        <tr><td colSpan={5}><div className="sc-body" style={{ color: 'var(--green)', padding: '2px 0' }}>{note}</div></td></tr>
      )}
      {assigning && (
        <tr>
          <td colSpan={5}>
            <AssignmentForm
              conferences={conferences}
              onCancel={() => setAssigning(false)}
              onSubmit={async (conferenceId, role, personId) => {
                setBusy(true);
                const res = await addMembership(user.user_id, {
                  conference_id: conferenceId, role, person_id: personId || undefined,
                });
                setBusy(false);
                if (res?.ok) { setAssigning(false); onChanged(); }
                else setNote("Couldn't add access — please try again.");
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function AddPersonPanel({ conferences, onCancel, onDone }:
  { conferences: ConferenceSummary[]; onCancel: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [assign, setAssign] = useState(false);
  const [conferenceId, setConferenceId] = useState('');
  const [role, setRole] = useState('secretariat');
  const [personId, setPersonId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const submit = async () => {
    if (!name.trim() || !email.trim() || !password) return;
    setBusy(true); setError('');
    const res = await createAdminUserDetailed({
      email: email.trim(), password, name: name.trim(), is_admin: isAdmin,
    });
    if (!res.ok) {
      setBusy(false);
      setError(res.reason === 'exists'
        ? 'Someone already has that email. Try a different one.'
        : "Couldn't add this person — please try again.");
      return;
    }
    // Optional first assignment.
    if (assign && conferenceId && res.user?.user_id) {
      await addMembership(res.user.user_id, {
        conference_id: conferenceId, role, person_id: personId || undefined,
      });
    }
    setBusy(false);
    onDone();
  };

  const bindsPerson = role === 'speaker' || role === 'chair';

  return (
    <div className="card" style={{ maxWidth: 640, marginBottom: 16 }}>
      <div className="section-title" style={{ marginTop: 0 }}>Add a person</div>
      <div className="frow col"><label>Full name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dr. Anita Rao" autoFocus />
      </div>
      <div className="frow col"><label>Email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="anita@example.com" autoComplete="off" />
      </div>
      <div className="frow col"><label>Temporary password</label>
        <div className="btnrow" style={{ alignItems: 'center' }}>
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="Set or generate one" style={{ flex: 1, minWidth: 180 }} className="picker-input" />
          <button className="btn sm" type="button" onClick={() => { setPassword(generatePassword()); setCopied(false); }}>Generate</button>
          {password && (
            <button className="btn sm" type="button"
              onClick={() => { navigator.clipboard?.writeText(password).then(() => setCopied(true)).catch(() => {}); }}>
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          )}
        </div>
        {password && <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>Share it with them securely — they can change it after signing in.</p>}
      </div>
      <label className="frow" style={{ alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
        <span>Make this person an administrator</span>
      </label>

      <label className="frow" style={{ alignItems: 'center', gap: 8, marginTop: 4 }}>
        <input type="checkbox" checked={assign} onChange={(e) => setAssign(e.target.checked)} />
        <span>Also give them access to a conference now</span>
      </label>

      {assign && (
        <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: 12, marginTop: 4 }}>
          <div className="frow col"><label>Conference</label>
            <select value={conferenceId} onChange={(e) => setConferenceId(e.target.value)} className="picker-input">
              <option value="">Choose a conference…</option>
              {conferences.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="frow col"><label>Role</label>
            <select value={role} onChange={(e) => { setRole(e.target.value); setPersonId(''); }} className="picker-input">
              {ROLE_OPTIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </div>
          {bindsPerson && conferenceId && (
            <div className="frow col"><label>Link to this person in the programme (optional)</label>
              <PersonSearch confId={conferenceId} value={personId} onChange={setPersonId} />
            </div>
          )}
        </div>
      )}

      {error && <div className="sc-body" style={{ color: 'var(--red)', margin: '4px 0 8px' }}>{error}</div>}
      <div className="btnrow" style={{ marginTop: 8 }}>
        <button className="btn ok" disabled={busy || !name.trim() || !email.trim() || !password} onClick={submit}>
          {busy ? 'Adding…' : 'Add person'}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Inline assignment mini-form used by per-user "Add to conference".
function AssignmentForm({ conferences, onCancel, onSubmit }: {
  conferences: ConferenceSummary[];
  onCancel: () => void;
  onSubmit: (conferenceId: string, role: string, personId: string) => void;
}) {
  const [conferenceId, setConferenceId] = useState('');
  const [role, setRole] = useState('secretariat');
  const [personId, setPersonId] = useState('');
  const bindsPerson = role === 'speaker' || role === 'chair';

  return (
    <div className="card" style={{ margin: '6px 0', maxWidth: 560 }}>
      <div className="frow col"><label>Conference</label>
        <select value={conferenceId} onChange={(e) => setConferenceId(e.target.value)} className="picker-input">
          <option value="">Choose a conference…</option>
          {conferences.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="frow col"><label>Role</label>
        <select value={role} onChange={(e) => { setRole(e.target.value); setPersonId(''); }} className="picker-input">
          {ROLE_OPTIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </div>
      {bindsPerson && conferenceId && (
        <div className="frow col"><label>Link to this person in the programme (optional)</label>
          <PersonSearch confId={conferenceId} value={personId} onChange={setPersonId} />
        </div>
      )}
      <div className="btnrow" style={{ marginTop: 6 }}>
        <button className="btn ok sm" disabled={!conferenceId} onClick={() => onSubmit(conferenceId, role, personId)}>Grant access</button>
        <button className="btn sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Standalone person search — fetches the conference agenda snapshot and filters people by name.
// Deliberately independent of the ConferenceView AgendaProvider (not available on this route).
function PersonSearch({ confId, value, onChange }:
  { confId: string; value: string; onChange: (id: string) => void }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let on = true;
    setPeople(null);
    getAgenda(confId).then((snap) => {
      if (on) setPeople(snap && Array.isArray(snap.people) ? snap.people : []);
    });
    return () => { on = false; };
  }, [confId]);

  const matches = useMemo(() => {
    if (!people) return [];
    const t = q.trim().toLowerCase();
    const base = [...people].sort((a, b) => a.name.localeCompare(b.name));
    if (!t) return base.slice(0, 8);
    return base.filter((p) => p.name.toLowerCase().includes(t)
      || (p.institution ?? '').toLowerCase().includes(t)).slice(0, 12);
  }, [people, q]);

  const chosen = value && people ? people.find((p) => p.id === value) : undefined;

  if (people === null) return <p className="muted" style={{ fontSize: 12 }}>Loading programme…</p>;

  if (chosen) {
    return (
      <div className="picked">
        <strong>{chosen.name}</strong>
        <span className="muted" style={{ fontSize: 12 }}>{chosen.institution}</span>
        <button className="btn sm" onClick={() => { onChange(''); setQ(''); }}>Change</button>
      </div>
    );
  }

  return (
    <>
      <input type="text" value={q} onChange={(e) => setQ(e.target.value)}
        placeholder="Type a name…" className="picker-input" style={{ width: '100%' }} />
      <div className="picklist">
        {matches.map((p) => (
          <button key={p.id} className="pickrow" onClick={() => { onChange(p.id); setQ(''); }}>
            <span>{p.name}</span>
            <span className="muted" style={{ fontSize: 11 }}>{p.institution}</span>
          </button>
        ))}
        {matches.length === 0 && <div className="muted" style={{ fontSize: 12, padding: 8 }}>No one found.</div>}
      </div>
    </>
  );
}

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
}
