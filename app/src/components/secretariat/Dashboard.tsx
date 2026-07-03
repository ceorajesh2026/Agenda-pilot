// The Secretariat's live control-room dashboard. Read-only monitoring: health numbers,
// the live Now/Next board across every hall, a speaker tracker for the day, channel
// status and anything that needs a human. Auto-refreshes from the server every 15s.
// Actions (reporting, approving, publishing) live on the Today tab — not here.
import { useEffect, useMemo, useState } from 'react';
import { useAgenda } from '../../lib/data';
import { publicLinks } from '../../lib/api';
import { runConstraints } from '../../lib/constraints';
import { checkin } from '../../lib/agent';
import { useWorkflow } from '../../lib/workflow';
import { getChangelog, getOutbox } from '../../lib/publish';
import type { Changelog, Outbox } from '../../lib/publish';
import { NowNextBoard } from './Today';
import { checkinDot, reachOf } from '../shared';

const POLL_MS = 15000;

interface LiveSession { id: string; day?: string; revised?: boolean; cancelled?: boolean; }

export default function Dashboard() {
  const { confId, seed } = useAgenda();
  const wf = useWorkflow();
  const [date, setDate] = useState(seed.days[Math.min(2, seed.days.length - 1)]?.date ?? seed.days[0]?.date ?? '');
  const [clock, setClock] = useState('11:00');
  const [cl, setCl] = useState<Changelog | null>(null);
  const [ob, setOb] = useState<Outbox | null>(null);
  const [liveSessions, setLiveSessions] = useState<LiveSession[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  const refresh = () => {
    getChangelog(confId).then(setCl);
    getOutbox(confId).then(setOb);
    fetch(publicLinks.agendaJson(confId))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setLiveSessions(j?.sessions ?? null))
      .catch(() => setLiveSessions(null));
    setFetchedAt(new Date());
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confId]);

  const online = cl !== null;

  // ---- health numbers ----
  const revisedTotal = (liveSessions ?? []).filter((s) => s.revised).length;
  const cancelledTotal = (liveSessions ?? []).filter((s) => s.cancelled).length;
  const todayCount = seed.sessions.filter((s) => s.date === date && s.type !== 'break' && s.start_min != null).length;

  const people = seed.people.filter((p) => !p.declined);
  const pctEmail = Math.round((100 * people.filter((p) => p.reachable_email).length) / people.length);
  const pctPhone = Math.round((100 * people.filter((p) => p.reachable_wa_sms).length) / people.length);

  const draftIds = new Set(seed.sessions.filter((s) => s.state === 'DRAFT').map((s) => s.id));
  const draftTopics = seed.slots.filter((sl) => draftIds.has(sl.session_id)).length;

  const findings = useMemo(() => runConstraints(seed).filter((f) => f.severity !== 'info'), [seed]);

  const stageText =
    wf.flow?.stage === 'options' ? 'Choosing a solution' :
    wf.flow?.stage === 'chair' ? 'Waiting for the Chair' :
    wf.flow?.stage === 'secretariat' ? 'Waiting for your sign-off' :
    wf.flow?.stage === 'published' ? 'Published — tracking acknowledgements' :
    'Nothing pending';
  const newReports = wf.reports.filter((r) => r.status === 'new').length;

  const acked = wf.flow?.stage === 'published' ? wf.flow.notifications.filter((n) => n.ack).length : null;
  const ackTotal = wf.flow?.stage === 'published' ? wf.flow.notifications.length : null;

  const latestPub = cl?.publications?.[0] ?? null;

  return (
    <div>
      {/* live header */}
      <div className="controls" style={{ marginBottom: 14 }}>
        <span className={`livedot ${online ? '' : 'off'}`} />
        <strong style={{ fontSize: 13 }}>{online ? 'LIVE' : 'OFFLINE'}</strong>
        <span className="muted" style={{ fontSize: 12 }}>
          {online
            ? `Agenda v${cl!.version} · published feed updated ${new Date(cl!.last_updated).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
            : 'Distribution server not running — showing the local programme only.'}
          {fetchedAt ? ` · checked ${fetchedAt.toLocaleTimeString()}` : ''}
        </span>
        <button className="btn sm" onClick={refresh} style={{ marginLeft: 'auto' }}>Refresh now</button>
      </div>

      {/* health cards */}
      <div className="grid cards">
        <div className="card">
          <div className="label">Agenda</div>
          <div className="big">{online ? `v${cl!.version}` : '—'}</div>
          <div className="hint">{revisedTotal} revised · {cancelledTotal} cancelled overall</div>
        </div>
        <div className="card">
          <div className="label">Sessions on {seed.days.find((d) => d.date === date)?.label.split(' (')[0] ?? 'this day'}</div>
          <div className="big">{todayCount}</div>
          <div className="hint">across {new Set(seed.sessions.filter((s) => s.date === date && s.start_min != null).map((s) => s.hall_id)).size} halls</div>
        </div>
        <div className="card">
          <div className="label">Approvals</div>
          <div className="big" style={{ fontSize: 20, lineHeight: '38px' }}>{stageText}</div>
          <div className="hint">{newReports ? `${newReports} new speaker report${newReports === 1 ? '' : 's'} waiting` : 'no new speaker reports'}</div>
        </div>
        {acked !== null && (
          <div className="card">
            <div className="label">Acknowledgements</div>
            <div className="big" style={{ color: acked === ackTotal ? 'var(--green)' : 'var(--amber)' }}>{acked}/{ackTotal}</div>
            <div className="hint">people who confirmed the latest change</div>
          </div>
        )}
        <div className="card">
          <div className="label">Reachable by email</div>
          <div className="big">{pctEmail}%</div>
          <div className="bar"><span style={{ width: `${pctEmail}%` }} /></div>
          <div className="hint">of {people.length} faculty</div>
        </div>
        <div className="card">
          <div className="label">Reachable by phone</div>
          <div className="big" style={{ color: 'var(--amber)' }}>{pctPhone}%</div>
          <div className="bar"><span style={{ width: `${pctPhone}%`, background: 'var(--amber)' }} /></div>
          <div className="hint">WhatsApp / SMS numbers on file</div>
        </div>
        <div className="card">
          <div className="label">Emails sent</div>
          <div className="big">{ob ? ob.emails.length : '—'}</div>
          <div className="hint">{ob?.emails.some((e) => e.kind === 'broadcast') ? 'incl. all-faculty broadcast' : 'personal + broadcast'}</div>
        </div>
        <div className="card">
          <div className="label">Still to schedule</div>
          <div className="big" style={{ color: 'var(--purple)' }}>{draftTopics}</div>
          <div className="hint">neurosurgery topics without times or speakers</div>
        </div>
      </div>

      {/* live board */}
      <NowNextBoard date={date} clock={clock} />

      {/* speaker tracker */}
      <SpeakerTracker date={date} clock={clock} />

      {/* channels */}
      {latestPub && (
        <>
          <div className="section-title">Latest change, everywhere it went</div>
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{latestPub.title}</div>
            <div className="btnrow">
              {latestPub.targets.map((t, i) => (
                <span key={i} className={`chip ${t.status === 'rate_limited' ? 'warning' : 'published'}`}>{t.name}</span>
              ))}
              {latestPub.pdfUrl && <a className="btn sm" href={latestPub.pdfUrl} target="_blank" rel="noreferrer">📄 PDF</a>}
              <a className="btn sm" href={publicLinks.agendaJson(confId)} target="_blank" rel="noreferrer">🌐 Public agenda</a>
            </div>
          </div>
        </>
      )}

      {/* problems */}
      {findings.length > 0 && (
        <>
          <div className="section-title">Worth checking ({findings.length})</div>
          {findings.slice(0, 6).map((f) => (
            <div className="finding warning" key={f.id}>
              <div className="body">
                <div className="fdetail" style={{ fontSize: 13, color: 'var(--text)' }}>{plainFinding(f.category, f.title, f.detail)}</div>
              </div>
            </div>
          ))}
          {findings.length > 6 && <p className="muted" style={{ fontSize: 12 }}>…and {findings.length - 6} more under Agenda → Problems.</p>}
        </>
      )}

      {/* demo controls — same convention as Today */}
      <div className="demo-row">
        <span className="muted" style={{ fontSize: 11 }}>Demo clock:</span>
        {seed.days.map((d) => (
          <button key={d.date} className={`pill sm ${d.date === date ? 'active' : ''}`} onClick={() => setDate(d.date)}>
            {d.label.split(' (')[0]}
          </button>
        ))}
        <input type="time" value={clock} onChange={(e) => setClock(e.target.value)} className="demo-time" />
      </div>
    </div>
  );
}

// findings → one plain sentence each
function plainFinding(category: string, title: string, detail: string): string {
  if (category === 'Missing moderator') return `${title.replace('No moderator: ', '"')}" has no moderator assigned yet.`;
  if (category === 'Unlinked speaker') return `${title.replace(' not linked to a contact', '')} appears in the programme but has no contact details on file.`;
  if (category === 'Unreachable faculty') return title.replace(' has no contact channel', " can't be reached by email or phone.");
  if (category === 'Duration mismatch') return `${title.replace('Timing drift: ', '"')}" — the talk timings don't quite fill the slot; worth a look.`;
  return `${title}. ${detail}`;
}

// ---------------------------------------------------------------- speaker tracker
function SpeakerTracker({ date, clock }: { date: string; clock: string }) {
  const { seed, peopleById, fmtMin } = useAgenda();
  const wf = useWorkflow();
  const [h, m] = clock.split(':').map(Number);
  const now = (h || 0) * 60 + (m || 0);

  const rows = useMemo(() => {
    const timed = seed.sessions.filter((s) => s.date === date && s.start_min != null && s.type !== 'break');
    const byId = new Map(timed.map((s) => [s.id, s]));
    const first = new Map<string, { start: number; title: string }>();
    for (const r of seed.roles) {
      if (!r.person_id) continue;
      const s = byId.get(r.session_id);
      if (!s) continue;
      const cur = first.get(r.person_id);
      if (!cur || s.start_min! < cur.start) first.set(r.person_id, { start: s.start_min!, title: s.title });
    }
    return [...first.entries()]
      .map(([pid, v]) => ({ p: peopleById.get(pid)!, ...v }))
      .filter((r) => r.p)
      .sort((a, b) => a.start - b.start);
  }, [date, seed, peopleById]);

  if (!rows.length) return null;

  return (
    <>
      <div className="section-title">Speaker tracker · {rows.length} people on this day</div>
      <div className="scroll" style={{ maxHeight: 340, overflowY: 'auto' }}>
        <table>
          <thead><tr><th>First on</th><th>Who</th><th>Session</th><th>Status</th><th>Contact</th></tr></thead>
          <tbody>
            {rows.map(({ p, start, title }) => {
              const status = checkin(p, wf.flow?.disruption);
              const soon = status !== 'On-site' && start - now <= 120 && start - now > -30;
              const reach = reachOf(p);
              return (
                <tr key={p.id} style={soon ? { background: 'rgba(245,158,11,.12)' } : undefined}>
                  <td className="stime" style={{ color: 'var(--accent)' }}>{fmtMin(start)}</td>
                  <td>{p.name}{soon && <span className="chip warning" style={{ marginLeft: 6 }}>due soon</span>}</td>
                  <td className="muted">{title}</td>
                  <td><span className={`dot ${checkinDot(status)}`} />{status}</td>
                  <td className="muted"><span className={`dot ${reach.cls}`} />{reach.text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
