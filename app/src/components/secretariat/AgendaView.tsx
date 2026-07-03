// Secretariat agenda browser: day pills, track filter, search, a collapsed
// plain-language problems panel, and session cards.
import { useMemo, useState } from 'react';
import { useAgenda } from '../../lib/data';
import type { Agenda } from '../../lib/data';
import { runConstraints } from '../../lib/constraints';
import type { Finding } from '../../lib/constraints';
import { RoleLine, SessionChips } from '../shared';

// translate findings into sentences a non-technical organizer instantly understands
function plainProblem(f: Finding, agenda: Agenda): string {
  const { seed, peopleById } = agenda;
  switch (f.category) {
    case 'Double-booking': {
      const who = f.personId ? peopleById.get(f.personId)?.name ?? 'Someone' : 'Someone';
      return `${who} is expected in two places at once — ${f.detail}`;
    }
    case 'Hall clash':
      return `Two sessions are booked into the same hall at the same time — ${f.detail}`;
    case 'Missing moderator': {
      const s = f.sessionIds[0] ? seed.sessions.find((x) => x.id === f.sessionIds[0]) : undefined;
      return `"${s?.title ?? 'A session'}" has no moderator assigned.`;
    }
    case 'Duration mismatch': {
      const s = f.sessionIds[0] ? seed.sessions.find((x) => x.id === f.sessionIds[0]) : undefined;
      return `The talks in "${s?.title ?? 'a session'}" don't quite fit its time slot — worth a quick check.`;
    }
    case 'Unlinked speaker': {
      const name = f.title.replace(/^"|" not linked to a contact$/g, '');
      const s = f.sessionIds[0] ? seed.sessions.find((x) => x.id === f.sessionIds[0]) : undefined;
      return `"${name}" appears in the programme${s ? ` ("${s.title}")` : ''} but has no contact details — they can't be notified.`;
    }
    case 'Unreachable faculty': {
      const who = f.personId ? peopleById.get(f.personId)?.name ?? 'Someone' : 'Someone';
      return `${who} is on the programme but has neither a working email nor a phone number.`;
    }
    default:
      return f.detail;
  }
}

export default function AgendaView() {
  const agenda = useAgenda();
  const { seed, slotsBySession, rolesBySession, peopleById } = agenda;
  const [date, setDate] = useState(seed.days[1]?.date ?? seed.days[0]?.date ?? '');
  const [track, setTrack] = useState('all');
  const [q, setQ] = useState('');

  const problems = useMemo(
    () => runConstraints(seed).filter((f) => f.severity !== 'info'),
    [seed],
  );

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return seed.sessions
      .filter((s) => s.date === date || (!s.date && track !== 'neurology'))
      .filter((s) => track === 'all' || s.track === track)
      .filter((s) => {
        if (!t) return true;
        if (s.title.toLowerCase().includes(t)) return true;
        const roles = rolesBySession.get(s.id) ?? [];
        return roles.some((r) => {
          const nm = r.person_id ? peopleById.get(r.person_id)?.name ?? r.name_raw : r.name_raw;
          return nm.toLowerCase().includes(t);
        });
      })
      .sort((a, b) => (a.start_min ?? 9999) - (b.start_min ?? 9999));
  }, [date, track, q, seed, rolesBySession, peopleById]);

  return (
    <div>
      <div className="controls">
        {seed.days.map((d) => (
          <button key={d.date} className={`pill ${d.date === date ? 'active' : ''}`} onClick={() => setDate(d.date)}>
            {d.label}
          </button>
        ))}
        <select value={track} onChange={(e) => setTrack(e.target.value)}>
          <option value="all">All tracks</option>
          {seed.tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <input type="text" placeholder="Find a session or speaker…" value={q}
          onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
      </div>

      <details className="problems">
        <summary>⚠ Problems ({problems.length})</summary>
        <div style={{ marginTop: 10 }}>
          {problems.map((f) => (
            <div className="finding warning" key={f.id}>
              <div className="body"><div className="fdetail" style={{ fontSize: 13, color: 'var(--text)' }}>{plainProblem(f, agenda)}</div></div>
            </div>
          ))}
          {problems.length === 0 && <p className="muted">Nothing needs fixing right now.</p>}
        </div>
      </details>

      {list.length === 0 && <p className="muted">No sessions match.</p>}
      {list.map((s) => {
        const roles = rolesBySession.get(s.id) ?? [];
        const slots = slotsBySession.get(s.id) ?? [];
        return (
          <div className="session" key={s.id}>
            <div className="shead">
              <span className="stime">{s.start ? `${s.start}–${s.end ?? '??'}` : '—'}</span>
              <span className="stitle">{s.title}</span>
              <SessionChips s={s} />
              <span className="chip track">{seed.tracks.find((t) => t.id === s.track)?.name ?? s.track}</span>
            </div>
            <div className="meta">
              {seed.halls.find((h) => h.id === s.hall_id)?.name}
              {s.type === 'break' ? ' · break' : ''}
            </div>
            {roles.map((r) => <RoleLine key={r.id} r={r} />)}
            {roles.length === 0 && s.state === 'DRAFT' && (
              <div className="roleline muted">{slots.length} topics — times and speakers to be confirmed</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
