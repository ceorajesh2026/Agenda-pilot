// Secretariat home. One big primary action, incoming speaker reports, the current
// approval status in plain language, a short "needs attention" list and a compact
// Now/Next board. The disruption flow replaces this content while reporting/choosing.
import { useEffect, useMemo, useState } from 'react';
import { useAgenda } from '../../lib/data';
import { publicLinks } from '../../lib/api';
import { checkin } from '../../lib/agent';
import { useWorkflow } from '../../lib/workflow';
import type { SpeakerReport } from '../../lib/workflow';
import DisruptionFlow from './DisruptionFlow';
import { KIND_TITLE } from '../shared';

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `${h} hour${h === 1 ? '' : 's'} ago`;
}

export default function Today() {
  const { confId, seed } = useAgenda();
  const wf = useWorkflow();
  const [date, setDate] = useState(seed.days[0]?.date ?? '');
  const [clock, setClock] = useState('11:00');
  const [inFlow, setInFlow] = useState(false);

  const stage = wf.flow?.stage;
  // while the user is reporting or picking options, the flow takes over the page
  const flowActive = inFlow && (!stage || stage === 'options');

  // once an option is chosen, drop back to the Today layout with status cards
  useEffect(() => {
    if (inFlow && stage && stage !== 'options') setInFlow(false);
  }, [inFlow, stage]);

  if (flowActive) {
    return <DisruptionFlow onBack={() => { if (stage === 'options') wf.resetFlow(); setInFlow(false); }} />;
  }

  const newReports = wf.reports.filter((r) => r.status === 'new');

  return (
    <div>
      {/* hero action row */}
      <div className="hero-row">
        <button className="btn hero" onClick={() => setInFlow(true)}>⚡ Report a disruption</button>
        <a className="quiet-link" href={`#/c/${encodeURIComponent(confId)}/import`}>📂 Import files</a>
        {date && <a className="quiet-link" href={publicLinks.printDay(confId, date)} target="_blank" rel="noreferrer">🖨 Print today's program</a>}
        <a className="quiet-link" href={publicLinks.agendaJson(confId)} target="_blank" rel="noreferrer">🌐 Public agenda</a>
      </div>

      {newReports.length > 0 && (
        <>
          <div className="section-title">New reports from speakers</div>
          {newReports.map((r) => <ReportCard key={r.id} r={r} onHandle={() => { wf.startHandling(r); setInFlow(true); }} />)}
        </>
      )}

      {wf.flow && stage === 'options' && (
        <div className="status-card amber">
          <div className="sc-title">✏ The Chair asked for a different option</div>
          <div className="sc-body">
            {wf.flow.audit.filter((a) => a.actor === 'Neurology Scientific Chair').slice(-1)[0]?.text ?? 'Please review the remaining options.'}
          </div>
          <div className="btnrow" style={{ marginTop: 10 }}>
            <button className="btn ok" onClick={() => setInFlow(true)}>Review options</button>
            <button className="btn" onClick={wf.resetFlow}>Drop this change</button>
          </div>
        </div>
      )}

      {wf.flow && stage && stage !== 'options' && <FlowStatus />}

      <NeedsAttention date={date} />

      <NowNextBoard date={date} clock={clock} />

      {/* demo controls — clearly secondary */}
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

// ---------------------------------------------------------------- report cards
function ReportCard({ r, onHandle }: { r: SpeakerReport; onHandle: () => void }) {
  const { peopleById, fmtMin } = useAgenda();
  const p = peopleById.get(r.personId);
  return (
    <div className="status-card amber">
      <div className="sc-title">
        {p?.name ?? 'A speaker'} — {r.kind === 'cancel' ? "can't attend" : `running late${r.etaMin != null ? `, arriving about ${fmtMin(r.etaMin)}` : ''}`}
      </div>
      <div className="sc-body">"{r.reason}" · reported {ago(r.at)}</div>
      <div className="btnrow" style={{ marginTop: 10 }}>
        <button className="btn ok" onClick={onHandle}>Find solutions</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- flow status
function FlowStatus() {
  const { peopleById } = useAgenda();
  const wf = useWorkflow();
  const flow = wf.flow!;
  const [busy, setBusy] = useState(false);
  const person = peopleById.get(flow.disruption.personId);

  const publish = async () => {
    setBusy(true);
    await wf.confirmPublish();
    setBusy(false);
  };

  return (
    <>
      {flow.stage === 'chair' && (
        <div className="status-card blue">
          <div className="sc-title">⏳ Waiting for Chair approval</div>
          <div className="sc-body">
            "{flow.chosen ? KIND_TITLE[flow.chosen.kind] : 'The plan'}" for {person?.name ?? 'the speaker'} has been sent to the
            Neurology Scientific Chair. Switch to the <strong>Chair</strong> view (top right) to review it as the Chair.
          </div>
        </div>
      )}

      {flow.stage === 'secretariat' && (
        <div className="status-card green">
          <div className="sc-title">✅ Chair approved — your final sign-off</div>
          <div className="sc-body">Check hall, AV and print logistics, then publish.</div>
          <div className="btnrow" style={{ marginTop: 10 }}>
            <button className="btn ok" disabled={busy} onClick={publish}>{busy ? 'Publishing…' : 'Confirm & publish'}</button>
            <button className="btn" disabled={busy} onClick={wf.sendBack}>Send back to Chair</button>
          </div>
        </div>
      )}

      {flow.stage === 'published' && <PublishedCard />}

      {flow.stage === 'rolledback' && (
        <div className="status-card amber">
          <div className="sc-title">↩ Rolled back</div>
          <div className="sc-body">The previous agenda is live again. Everyone already notified should be told the change is off.</div>
          <div className="btnrow" style={{ marginTop: 10 }}>
            <button className="btn" onClick={wf.resetFlow}>Done</button>
          </div>
        </div>
      )}

      <AuditTrail />
    </>
  );
}

// Colours a publish-target chip by its backend-provided status string. The 'Email outbox'
// target now carries a real delivery status ('sent' / 'sent to test inbox' / 'failed' / …);
// other targets keep their existing 'rate_limited'/ok behaviour. Null-safe on empty status.
function targetChipClass(status: string): string {
  const s = (status || '').toLowerCase();
  if (s.includes('fail')) return 'error';
  if (s.includes('test') || s.includes('simulat') || s === 'rate_limited' || s.includes('partial')) return 'warning';
  if (s.includes('sent') || s.includes('ok') || s.includes('deliver') || s === 'published') return 'published';
  return 'published';
}

function PublishedCard() {
  const wf = useWorkflow();
  const flow = wf.flow!;
  const dist = flow.distribution;
  const acked = flow.notifications.filter((n) => n.ack).length;
  const total = flow.notifications.length;
  const sent = dist?.publication?.notifications?.length ?? total;

  return (
    <div className="status-card green">
      <div className="sc-title">✅ Published — revised agenda is live{dist?.version ? ` (v${dist.version})` : ''}</div>

      {dist?.ok && (
        <div className="btnrow" style={{ marginTop: 8 }}>
          {dist.publication.targets.map((t, i) => {
            // The Email outbox target now carries a real delivery status string — show it as-is
            // (e.g. "sent" / "sent to test inbox" / "failed") next to the target name.
            const isEmail = /email outbox/i.test(t.name);
            const label = isEmail && t.status ? `${t.name} · ${t.status}` : t.name;
            return (
              <span key={i} className={`chip ${targetChipClass(t.status)}`} title={t.detail || undefined}>{label}</span>
            );
          })}
        </div>
      )}
      {!dist?.ok && (
        <div className="sc-body">The distribution server is offline — the change is saved here and will go out once it's running.</div>
      )}

      {flow.pdfUrl && (
        <div style={{ marginTop: 10 }}>
          <a className="btn" href={flow.pdfUrl} target="_blank" rel="noreferrer">📄 Revised agenda (PDF)</a>
        </div>
      )}

      {dist?.ok && (
        <div className="sc-body" style={{ marginTop: 8 }}>
          {sent} emails queued · WhatsApp group posted — see <strong>Activity</strong>.
        </div>
      )}

      <div className="sc-body" style={{ marginTop: 10 }}>
        <strong>{acked}/{total} acknowledged</strong>
        <div className="ackbar"><span style={{ width: total ? `${(100 * acked) / total}%` : '0%' }} /></div>
      </div>

      {flow.notifications.map((n, i) => (
        <div className="notif" key={i}>
          <span className={`chip ${n.channel === 'email' ? 'info' : n.channel === 'phone-call' ? 'error' : 'published'}`}>{n.channel}</span>
          <div className="body"><strong>{n.to}</strong><div className="fdetail">{n.message}</div></div>
          {n.ack ? <span className="chip published">✓ seen</span>
            : <button className="btn sm" onClick={() => wf.ack(i)}>Acknowledge</button>}
        </div>
      ))}

      <div className="btnrow" style={{ marginTop: 12 }}>
        <button className="btn bad" onClick={wf.rollback}>↩ Roll back</button>
        <button className="btn" onClick={wf.resetFlow}>Done</button>
      </div>
    </div>
  );
}

function AuditTrail() {
  const wf = useWorkflow();
  const audit = wf.flow?.audit ?? [];
  if (!audit.length) return null;
  return (
    <>
      <div className="section-title">What happened so far</div>
      <div className="timeline">
        {audit.map((a, i) => (
          <div className="tl" key={i}>
            <span className="tlt">{a.at}</span>
            <span className="tla">{a.actor}</span>
            <span className="tlx">{a.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- needs attention
function NeedsAttention({ date }: { date: string }) {
  const { seed, peopleById, rolesBySession } = useAgenda();
  const wf = useWorkflow();
  const items = useMemo(() => {
    const out: string[] = [];
    const todaySessions = seed.sessions.filter((s) => s.date === date && s.start_min != null && s.type !== 'break');
    const todayIds = new Set(todaySessions.map((s) => s.id));

    // international speakers on today's programme who aren't on-site yet
    const seen = new Set<string>();
    for (const r of seed.roles) {
      if (!r.person_id || !todayIds.has(r.session_id) || seen.has(r.person_id)) continue;
      seen.add(r.person_id);
      const p = peopleById.get(r.person_id);
      if (!p) continue;
      const status = checkin(p, wf.flow?.disruption);
      if (p.segments.some((sg) => sg.includes('International')) && status !== 'On-site') {
        const s = todaySessions.find((x) => x.id === r.session_id);
        out.push(`${p.name} (${status.toLowerCase()}) speaks today at ${s?.start ?? '—'} — worth a check-in call.`);
      }
    }

    // sessions today with unlinked speakers
    for (const s of todaySessions) {
      const unlinked = (rolesBySession.get(s.id) ?? []).filter((r) => r.match === 'unmatched');
      for (const r of unlinked) {
        out.push(`"${r.name_raw}" appears in "${s.title}" (${s.start}) but has no contact details — they can't be notified.`);
      }
    }
    return out;
  }, [date, wf.flow?.disruption, seed, peopleById, rolesBySession]);

  // unacknowledged critical notifications from a published flow
  const criticalUnacked = (wf.flow?.stage === 'published' ? wf.flow.notifications : [])
    .filter((n) => n.critical && !n.ack)
    .map((n) => `${n.to} hasn't yet confirmed they've seen the schedule change — chase by ${n.channel}.`);

  const all = [...criticalUnacked, ...items].slice(0, 6);
  if (!all.length) return null;

  return (
    <>
      <div className="section-title">Needs attention</div>
      {all.map((t, i) => (
        <div className="finding warning" key={i}>
          <div className="body"><div className="fdetail" style={{ fontSize: 13, color: 'var(--text)' }}>{t}</div></div>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- now / next
// (exported so the live Dashboard can reuse the same board)
export function NowNextBoard({ date, clock }: { date: string; clock: string }) {
  const { seed, fmtMin } = useAgenda();
  const [h, m] = clock.split(':').map(Number);
  const now = (h || 0) * 60 + (m || 0);
  const timed = seed.sessions.filter((s) => s.date === date && s.start_min != null && s.type !== 'break');
  const halls = seed.halls.filter((hh) => timed.some((s) => s.hall_id === hh.id));
  if (!halls.length) {
    return (
      <>
        <div className="section-title">On stage right now</div>
        <p className="muted">No timed sessions on this day yet.</p>
      </>
    );
  }
  return (
    <>
      <div className="section-title">On stage right now · {fmtMin(now)}</div>
      <div className="nownext">
        {halls.map((hh) => {
          const list = timed.filter((s) => s.hall_id === hh.id).sort((a, b) => a.start_min! - b.start_min!);
          const current = list.find((s) => s.start_min! <= now && now < (s.end_min ?? s.start_min! + 30));
          const next = list.find((s) => s.start_min! > now);
          return (
            <div className="hallcard" key={hh.id}>
              <h3>{hh.name}</h3>
              <div className="slotline">
                <span className="lbl now">● NOW</span>
                {current
                  ? <div><div>{current.title}</div><div className="when">{current.start}–{current.end}</div></div>
                  : <div className="muted" style={{ marginTop: 4 }}>— between sessions —</div>}
              </div>
              <div className="slotline">
                <span className="lbl next">NEXT</span>
                {next
                  ? <div><div>{next.title}</div><div className="when">{next.start}–{next.end}</div></div>
                  : <div className="muted" style={{ marginTop: 4 }}>— end of day —</div>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
