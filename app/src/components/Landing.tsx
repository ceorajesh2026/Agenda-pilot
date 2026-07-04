// Landing screen: welcoming home for the multi-conference template. Lists the user's
// conferences as cards (from GET /conferences), offers a "＋ New conference" inline form,
// and a Settings entry. Degrades to a friendly offline note when the API is unreachable.
import { useEffect, useState } from 'react';
import { listConferences, createConference } from '../lib/api';
import type { ConferenceSummary } from '../lib/api';
import { useAuth } from '../lib/auth';
import AccountMenu from './AccountMenu';

type LoadState = 'loading' | 'ready' | 'offline';

function fmtDates(start: string | null, end: string | null): string {
  if (!start) return 'Dates to be confirmed';
  const s = new Date(start);
  const e = end ? new Date(end) : s;
  const mon = (d: Date) => d.toLocaleString('en', { month: 'short' });
  if (isNaN(s.getTime())) return 'Dates to be confirmed';
  if (isNaN(e.getTime()) || start === end) return `${s.getDate()} ${mon(s)} ${s.getFullYear()}`;
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return `${s.getDate()}–${e.getDate()} ${mon(s)} ${s.getFullYear()}`;
  }
  return `${s.getDate()} ${mon(s)} – ${e.getDate()} ${mon(e)} ${e.getFullYear()}`;
}

export default function Landing({ onOpen, onSettings, onAdmin }:
  { onOpen: (id: string) => void; onSettings: () => void; onAdmin: () => void }) {
  const { me } = useAuth();
  const isAdmin = !!me?.user.is_admin;
  const [state, setState] = useState<LoadState>('loading');
  const [conferences, setConferences] = useState<ConferenceSummary[]>([]);
  const [creating, setCreating] = useState(false);

  const load = () => {
    setState('loading');
    listConferences().then((res) => {
      if (res && Array.isArray(res.conferences)) {
        setConferences(res.conferences);
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
        <h1>AgendaPilot</h1>
        <div className="sub">Run your conference agenda — disruptions handled in minutes</div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {isAdmin && <button className="btn sm" onClick={onAdmin}>👥 Team &amp; access</button>}
          {isAdmin && <button className="btn sm" onClick={onSettings}>⚙️ Settings</button>}
          <AccountMenu />
        </div>
      </header>

      {state === 'loading' && (
        <div className="landing-empty">
          <div className="spinner" />
          <p className="muted">Loading your conferences…</p>
        </div>
      )}

      {state === 'offline' && (
        <div className="landing-empty">
          <div className="status-card amber" style={{ maxWidth: 520, margin: '0 auto', textAlign: 'left' }}>
            <div className="sc-title">The server isn't reachable</div>
            <div className="sc-body">
              We couldn't load your conferences. This usually means the backend isn't running yet.
              Check your connection and try again — nothing has been lost.
            </div>
            <div className="btnrow" style={{ marginTop: 12 }}>
              <button className="btn ok" onClick={load}>Try again</button>
              <button className="btn" onClick={onSettings}>⚙️ Settings</button>
            </div>
          </div>
        </div>
      )}

      {state === 'ready' && !isAdmin && conferences.length === 0 && (
        <div className="landing-empty">
          <div className="setup-hero" style={{ maxWidth: 460 }}>
            <div className="setup-emoji">🗓️</div>
            <h2 className="setup-title">No conferences yet</h2>
            <p className="setup-lead">Ask your organizer to add you to a conference. Once they do, it'll appear here.</p>
          </div>
        </div>
      )}

      {state === 'ready' && (isAdmin || conferences.length > 0) && (
        <>
          <div className="section-title" style={{ marginTop: 8 }}>Your conferences</div>
          <div className="conf-grid">
            {conferences.map((c) => (
              <button key={c.id} className="conf-card" onClick={() => onOpen(c.id)}>
                <div className="conf-card-head">
                  <span className="conf-name">{c.name}</span>
                  {c.sample && <span className="chip info">Sample</span>}
                </div>
                <div className="conf-dates">{fmtDates(c.start_date, c.end_date)}</div>
                <div className="conf-foot">
                  <span className={`chip ${statusChip(c.status)}`}>{c.status || 'draft'}</span>
                  <span className="conf-open">Open →</span>
                </div>
              </button>
            ))}

            {isAdmin && (creating
              ? <NewConferenceForm onCreated={(id) => { setCreating(false); onOpen(id); }} onCancel={() => setCreating(false)} onLocalAdd={load} />
              : (
                <button className="conf-card conf-new" onClick={() => setCreating(true)}>
                  <span className="conf-plus">＋</span>
                  <span>New conference</span>
                </button>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

function statusChip(status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'published' || s === 'live') return 'published';
  if (s === 'archived' || s === 'closed') return 'track';
  return 'warning';
}

function NewConferenceForm({ onCreated, onCancel, onLocalAdd }:
  { onCreated: (id: string) => void; onCancel: () => void; onLocalAdd: () => void }) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    const res = await createConference({
      name: name.trim(),
      start_date: start || undefined,
      end_date: end || undefined,
    });
    setBusy(false);
    if (res?.conference?.id) {
      onCreated(res.conference.id);
    } else {
      setError("Couldn't create the conference — the server may be offline. Please try again.");
      onLocalAdd();
    }
  };

  return (
    <div className="conf-card conf-form">
      <div className="section-title" style={{ margin: '0 0 10px' }}>New conference</div>
      <div className="frow col"><label>Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Spring Cardiology Summit" autoFocus />
      </div>
      <div className="frow col"><label>Start date</label>
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
      </div>
      <div className="frow col"><label>End date</label>
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
      </div>
      {error && <div className="sc-body" style={{ color: 'var(--red)', marginBottom: 8 }}>{error}</div>}
      <div className="btnrow">
        <button className="btn ok" disabled={busy || !name.trim()} onClick={submit}>{busy ? 'Creating…' : 'Create & open'}</button>
        <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
