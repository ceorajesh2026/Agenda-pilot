// A speaker's own page: pick your name once, then see your schedule, any messages
// waiting for you, and one big button to tell the team you're delayed.
import { useMemo, useState } from 'react';
import { useAgenda } from '../lib/data';
import { publicLinks } from '../lib/api';
import { useWorkflow } from '../lib/workflow';
import { PersonPicker, useDemoPerson } from './shared';

export default function SpeakerView() {
  const [pid, setPid] = useState('');
  const demo = useDemoPerson();
  if (!pid) {
    return (
      <div className="chair-wrap">
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>Select your name</div>
          <PersonPicker value={pid} onChange={setPid} placeholder="Type your name…" showStatus={false} />
          {demo && (
            <div style={{ marginTop: 12 }}>
              <button className="pill" onClick={() => setPid(demo.id)}>Demo: Dr. {demo.name}</button>
            </div>
          )}
        </div>
      </div>
    );
  }
  return <SpeakerHome pid={pid} onSwitch={() => setPid('')} />;
}

function SpeakerHome({ pid, onSwitch }: { pid: string; onSwitch: () => void }) {
  const { confId, seed, peopleById, rolesByPerson, ROLE_LABEL } = useAgenda();
  const wf = useWorkflow();
  const person = peopleById.get(pid)!;
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);

  const mySessions = useMemo(() => {
    const roles = rolesByPerson.get(pid) ?? [];
    return roles.map((r) => ({ r, s: seed.sessions.find((x) => x.id === r.session_id) }))
      .filter((x) => !!x.s)
      .sort((a, b) => (a.s!.date ?? '').localeCompare(b.s!.date ?? '') || (a.s!.start_min ?? 0) - (b.s!.start_min ?? 0));
  }, [pid, seed, rolesByPerson]);

  // pending notifications addressed to me from the current flow
  const pending = (wf.flow?.stage === 'published' ? wf.flow.notifications : [])
    .map((n, idx) => ({ n, idx }))
    .filter((x) => x.n.personId === pid && !x.n.ack);

  return (
    <div className="chair-wrap">
      <div className="controls" style={{ marginBottom: 10 }}>
        <strong>{person.name}</strong>
        <span className="muted" style={{ fontSize: 12 }}>{person.institution}</span>
        <button className="btn sm" onClick={onSwitch}>Not you?</button>
      </div>

      {pending.length > 0 && (
        <>
          <div className="section-title">Messages for you</div>
          {pending.map(({ n, idx }) => (
            <div className="status-card amber" key={idx}>
              <div className="sc-body">{n.message}</div>
              <div className="btnrow" style={{ marginTop: 10 }}>
                <button className="btn ok" onClick={() => wf.ack(idx)}>Acknowledge</button>
              </div>
            </div>
          ))}
        </>
      )}

      {reported && (
        <div className="status-card green">
          <div className="sc-title">✅ The organizing team has been notified</div>
          <div className="sc-body">They'll rearrange things and keep you posted.</div>
        </div>
      )}

      {!reporting && (
        <button className="btn hero full" style={{ margin: '14px 0' }} onClick={() => { setReporting(true); setReported(false); }}>
          🛫 I'm delayed / can't attend
        </button>
      )}
      {reporting && (
        <ReportForm person={person} onDone={() => { setReporting(false); setReported(true); }}
          onCancel={() => setReporting(false)} />
      )}

      <div className="section-title">My schedule</div>
      {mySessions.length === 0 && <p className="muted">You have no scheduled sessions.</p>}
      {mySessions.map(({ r, s }) => (
        <div className="session" key={r.id}>
          <div className="shead">
            <span className="stime">{s!.start ? `${s!.start}–${s!.end ?? ''}` : '—'}</span>
            <span className="stitle">{s!.title}</span>
            {s!.state === 'REVISED' && <span className="chip warning">REVISED</span>}
            {s!.state === 'CANCELLED' && <span className="chip error">CANCELLED</span>}
          </div>
          <div className="meta">
            {s!.date ?? 'Date to be confirmed'} · {seed.halls.find((h) => h.id === s!.hall_id)?.name} · {ROLE_LABEL[r.role_type] ?? r.role_type}
          </div>
        </div>
      ))}
      <p style={{ marginTop: 12 }}>
        <a href={publicLinks.personIcs(confId, pid)} target="_blank" rel="noreferrer">📅 Subscribe to my calendar</a>
      </p>
    </div>
  );
}

function ReportForm({ person, onDone, onCancel }: { person: { id: string; name: string }; onDone: () => void; onCancel: () => void }) {
  const wf = useWorkflow();
  const [kind, setKind] = useState<'delay' | 'cancel'>('delay');
  const [eta, setEta] = useState('13:30');
  const [reason, setReason] = useState('');

  const submit = () => {
    const [h, m] = eta.split(':').map(Number);
    wf.submitReport({
      personId: person.id, kind,
      etaMin: kind === 'delay' ? h * 60 + m : null,
      reason: reason || (kind === 'cancel' ? 'Unable to attend' : 'Running late'),
      source: 'speaker',
    });
    onDone();
  };

  return (
    <div className="card" style={{ margin: '14px 0' }}>
      <div className="section-title" style={{ marginTop: 0 }}>Tell the team what's happened</div>
      <div className="frow col"><label>Reporting as</label><strong>{person.name}</strong></div>
      <div className="frow col"><label>What's happened?</label>
        <div className="radio-row">
          <label className={`radio-opt ${kind === 'delay' ? 'active' : ''}`}>
            <input type="radio" checked={kind === 'delay'} onChange={() => setKind('delay')} /> I'm running late
          </label>
          <label className={`radio-opt ${kind === 'cancel' ? 'active' : ''}`}>
            <input type="radio" checked={kind === 'cancel'} onChange={() => setKind('cancel')} /> I can't attend
          </label>
        </div>
      </div>
      {kind === 'delay' && (
        <div className="frow col"><label>Earliest I can arrive</label>
          <input type="time" value={eta} onChange={(e) => setEta(e.target.value)} style={{ maxWidth: 160 }} />
        </div>
      )}
      <div className="frow col"><label>Reason (optional)</label>
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. flight delayed" style={{ width: '100%' }} />
      </div>
      <div className="btnrow">
        <button className="btn ok" onClick={submit}>Send to the organizing team</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
