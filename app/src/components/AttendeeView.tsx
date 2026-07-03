// The public-facing agenda. Read-only, zero admin UI. Pulls the live published feed
// when the server is up; falls back to the bundled programme when it isn't.
import { useEffect, useMemo, useState } from 'react';
import { useAgenda } from '../lib/data';
import type { Agenda } from '../lib/data';
import { publicLinks } from '../lib/api';

interface PublicSession {
  id: string; title: string; date: string | null; start: string | null; end: string | null;
  hall?: string | null; state?: string; speakers?: string[];
  day?: string | null; // the live public feed uses `day` instead of `date`
}
interface PublicAgenda { last_updated?: string; sessions?: PublicSession[]; }

function localSessions(agenda: Agenda): PublicSession[] {
  const { seed, rolesBySession, peopleById } = agenda;
  return seed.sessions
    .filter((s) => s.type !== 'break' && s.start_min != null)
    .map((s) => ({
      id: s.id, title: s.title, date: s.date, start: s.start, end: s.end,
      hall: seed.halls.find((h) => h.id === s.hall_id)?.name ?? null,
      state: s.state,
      speakers: (rolesBySession.get(s.id) ?? [])
        .filter((r) => r.role_type === 'speaker')
        .map((r) => (r.person_id ? peopleById.get(r.person_id)?.name ?? r.name_raw : r.name_raw)),
    }));
}

export default function AttendeeView() {
  const agenda = useAgenda();
  const { confId, seed } = agenda;
  const [date, setDate] = useState(seed.days[1]?.date ?? seed.days[0]?.date ?? '');
  const [live, setLive] = useState<PublicAgenda | null>(null);

  useEffect(() => {
    let on = true;
    fetch(publicLinks.agendaJson(confId))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (on) setLive(j as PublicAgenda | null); })
      .catch(() => { if (on) setLive(null); });
    return () => { on = false; };
  }, [confId]);

  const sessions = useMemo<PublicSession[]>(() => {
    if (live?.sessions?.length) return live.sessions.map((s) => ({ ...s, date: s.date ?? s.day ?? null }));
    return localSessions(agenda);
  }, [live, agenda]);

  const list = sessions
    .filter((s) => s.date === date)
    .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));

  const updated = live?.last_updated
    ? new Date(live.last_updated).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
    : null;

  const dateRange = eventDateRange(seed.event.start_date, seed.event.end_date);

  return (
    <div>
      <div style={{ margin: '4px 0 14px' }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>{seed.event.name}</h2>
        <div className="muted" style={{ fontSize: 12.5 }}>
          {dateRange}{dateRange && updated ? ' · ' : ''}{updated ? `Last updated ${updated}` : ''}
        </div>
      </div>

      <div className="controls">
        {seed.days.map((d) => (
          <button key={d.date} className={`pill ${d.date === date ? 'active' : ''}`} onClick={() => setDate(d.date)}>
            {d.label}
          </button>
        ))}
      </div>

      {list.length === 0 && <p className="muted">The programme for this day will be announced soon.</p>}
      {list.map((s) => (
        <div className="session" key={s.id}>
          <div className="shead">
            <span className="stime">{s.start ? `${s.start}–${s.end ?? ''}` : '—'}</span>
            <span className="stitle">{s.title}</span>
            {s.state === 'REVISED' && <span className="chip warning">REVISED</span>}
            {s.state === 'CANCELLED' && <span className="chip error">CANCELLED</span>}
          </div>
          <div className="meta">
            {s.hall ?? ''}
            {s.speakers && s.speakers.length > 0 ? ` · ${s.speakers.join(', ')}` : ''}
          </div>
        </div>
      ))}

      <p style={{ marginTop: 16 }}>
        <a href={publicLinks.agendaIcs(confId)} target="_blank" rel="noreferrer">📅 Subscribe to the full calendar</a>
      </p>
    </div>
  );
}

// "20–23 Aug 2026" from ISO start/end dates; empty string if unknown.
function eventDateRange(start: string, end: string): string {
  if (!start) return '';
  const s = new Date(start);
  const e = end ? new Date(end) : s;
  if (isNaN(s.getTime())) return '';
  const mon = (d: Date) => d.toLocaleString('en', { month: 'short' });
  if (isNaN(e.getTime()) || start === end) {
    return `${s.getDate()} ${mon(s)} ${s.getFullYear()}`;
  }
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return `${s.getDate()}–${e.getDate()} ${mon(s)} ${s.getFullYear()}`;
  }
  return `${s.getDate()} ${mon(s)} – ${e.getDate()} ${mon(e)} ${e.getFullYear()}`;
}
