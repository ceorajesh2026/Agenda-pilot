// Small building blocks shared across the role views. Plain-language only — no jargon.
// Data now comes from the AgendaProvider (useAgenda) rather than a static seed import.
import { useMemo, useState } from 'react';
import { useAgenda } from '../lib/data';
import type { Agenda } from '../lib/data';
import type { Person, Session, Role } from '../lib/types';
import { checkin } from '../lib/agent';
import type { AgentOption } from '../lib/agent';

// ---- assigned faculty: anyone with a timed role, sorted by name ----
export function assignedFaculty(agenda: Agenda): Person[] {
  const { seed, peopleById } = agenda;
  return [...new Set(
    seed.roles.filter((r) => {
      const s = seed.sessions.find((x) => x.id === r.session_id);
      return r.person_id && s && s.start_min != null;
    }).map((r) => r.person_id!),
  )].map((id) => peopleById.get(id)!).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// hook form — memoized per snapshot
export function useAssigned(): Person[] {
  const agenda = useAgenda();
  return useMemo(() => assignedFaculty(agenda), [agenda]);
}

// A demo speaker used by the "load demo" shortcuts. Prefers Dr. Dubey when present, else the
// first assigned speaker — so the template works for any conference, not just the sample.
export function useDemoPerson(): Person | undefined {
  const assigned = useAssigned();
  return useMemo(() =>
    assigned.find((p) => p.name.toLowerCase().includes('divyanshu'))
    ?? assigned.find((p) => p.name.toLowerCase().includes('dubey'))
    ?? assigned[0],
  [assigned]);
}

// ---- reachability, kept as coloured dots (no jargon) ----
export function reachOf(p: Person): { cls: string; text: string } {
  if (p.reachable_email && p.reachable_wa_sms) return { cls: 'green', text: 'email + phone' };
  if (p.reachable_email) return { cls: 'amber', text: 'email only' };
  if (p.reachable_wa_sms) return { cls: 'amber', text: 'phone only' };
  return { cls: 'red', text: 'no contact details' };
}

// ---- check-in label → dot colour ----
export function checkinDot(status: string): string {
  if (status === 'On-site') return 'green';
  if (status === 'Cancelled' || status === 'Unknown') return 'red';
  return 'amber';
}

// ---- plain-language kind labels for options ----
export const KIND_TITLE: Record<AgentOption['kind'], string> = {
  swap: 'Swap two talks',
  substitute: 'Bring in a backup speaker',
  absorb: 'Absorb into the surrounding session',
};

// ---- Low / Medium / High disruption from the (hidden) score ----
export function disruptionLevel(score: number): { label: string; cls: string } {
  if (score <= 20) return { label: 'Low disruption', cls: 'published' };
  if (score <= 28) return { label: 'Medium disruption', cls: 'warning' };
  return { label: 'High disruption', cls: 'error' };
}

// how many people a change touches
export function affectedCount(o: AgentOption): number {
  return new Set(o.notifications.map((n) => n.personId ?? n.to)).size;
}

// ---- speaker line with a reachability dot (plain language) ----
export function RoleLine({ r }: { r: Role }) {
  const { peopleById, ROLE_LABEL } = useAgenda();
  let dot = 'gray';
  let who = r.name_raw;
  if (r.match === 'group') dot = 'gray';
  else if (!r.person_id) dot = 'red';
  else {
    const p = peopleById.get(r.person_id);
    if (p) { dot = reachOf(p).cls; who = p.name; }
  }
  return (
    <div className="roleline">
      <span className="rt">{ROLE_LABEL[r.role_type] ?? r.role_type}: </span>
      <span className={`dot ${dot}`} />{who}
      {r.match === 'unmatched' && <span className="muted"> — no contact details on file</span>}
      {r.match === 'ambiguous' && <span className="muted"> — needs checking</span>}
    </div>
  );
}

// ---- session status chip in plain language ----
export function SessionChips({ s }: { s: Session }) {
  return (
    <>
      {s.state === 'REVISED' && <span className="chip warning">REVISED</span>}
      {s.state === 'CANCELLED' && <span className="chip error">CANCELLED</span>}
      {s.state === 'DRAFT' && <span className="chip draft">Not scheduled yet</span>}
    </>
  );
}

// ---- searchable person picker over the assigned faculty ----
export function PersonPicker({
  value, onChange, placeholder = 'Type a name…', showStatus = true,
}: {
  value: string; onChange: (id: string) => void; placeholder?: string; showStatus?: boolean;
}) {
  const { peopleById } = useAgenda();
  const assigned = useAssigned();
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return assigned.slice(0, 8);
    return assigned.filter((p) => p.name.toLowerCase().includes(t)
      || p.institution.toLowerCase().includes(t)).slice(0, 12);
  }, [q, assigned]);
  const chosen = value ? peopleById.get(value) : undefined;
  return (
    <div>
      {chosen && (
        <div className="picked">
          <span className={`dot ${checkinDot(checkin(chosen))}`} />
          <strong>{chosen.name}</strong>
          <span className="muted" style={{ fontSize: 12 }}>{chosen.institution}</span>
          <button className="btn sm" onClick={() => { onChange(''); setQ(''); }}>Change</button>
        </div>
      )}
      {!chosen && (
        <>
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder}
            style={{ width: '100%' }} className="picker-input" />
          <div className="picklist">
            {matches.map((p) => (
              <button key={p.id} className="pickrow" onClick={() => { onChange(p.id); setQ(''); }}>
                {showStatus && <span className={`dot ${checkinDot(checkin(p))}`} />}
                <span>{p.name}</span>
                <span className="muted" style={{ fontSize: 11 }}>
                  {showStatus ? checkin(p) : p.institution}
                </span>
              </button>
            ))}
            {matches.length === 0 && <div className="muted" style={{ fontSize: 12, padding: 8 }}>No one found.</div>}
          </div>
        </>
      )}
    </div>
  );
}
