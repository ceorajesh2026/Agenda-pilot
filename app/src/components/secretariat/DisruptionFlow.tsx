// The "Report a disruption" flow: Step 1 (report form) → Step 2 (plain-language options).
// After an option is chosen the flow control returns to the Today layout, which shows the
// "Waiting for the Chair" status card.
import { useEffect, useState } from 'react';
import { useAgenda } from '../../lib/data';
import { generateOptions } from '../../lib/agent';
import type { Disruption, AgentOption } from '../../lib/agent';
import { proseHealth } from '../../lib/prose';
import { useWorkflow } from '../../lib/workflow';
import { useDemoPerson, KIND_TITLE, disruptionLevel, affectedCount, PersonPicker } from '../shared';

export default function DisruptionFlow({ onBack }: { onBack: () => void }) {
  const wf = useWorkflow();
  const stage = wf.flow?.stage;

  // if a flow already exists (chosen etc.), Today handles the status — this component
  // only owns the "report" and "options" steps.
  if (!wf.flow || stage === undefined) return <ReportStep onBack={onBack} />;
  if (stage === 'options') return <OptionsStep onBack={onBack} />;
  return <ReportStep onBack={onBack} />;
}

// ---------------------------------------------------------------- Step 1: report
function ReportStep({ onBack }: { onBack: () => void }) {
  const wf = useWorkflow();
  const demo = useDemoPerson();
  const [pid, setPid] = useState('');
  const [kind, setKind] = useState<'delay' | 'cancel'>('delay');
  const [eta, setEta] = useState('13:30');
  const [reason, setReason] = useState('');

  const submit = () => {
    if (!pid) return;
    const [h, m] = eta.split(':').map(Number);
    const dis: Disruption = {
      personId: pid, kind, etaMin: kind === 'delay' ? h * 60 + m : null,
      reason: reason || (kind === 'cancel' ? 'Unable to attend' : 'Running late'),
      reportedAtMin: new Date().getHours() * 60 + new Date().getMinutes(),
    };
    wf.reportAndHandle(dis);
  };

  const loadDemo = () => {
    if (!demo) return;
    wf.reportAndHandle({
      personId: demo.id, kind: 'delay', etaMin: 810,
      reason: 'Connecting flight delayed; new ETA 13:30',
      reportedAtMin: new Date().getHours() * 60 + new Date().getMinutes(),
    });
  };

  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <button className="linkback" onClick={onBack}>← Back to Today</button>
      <div className="section-title" style={{ marginTop: 6 }}>Step 1 · Who is affected?</div>

      <div className="frow col"><label>Speaker or chair</label>
        <PersonPicker value={pid} onChange={setPid} placeholder="Find a name…" />
      </div>

      <div className="frow col"><label>What has happened?</label>
        <div className="radio-row">
          <label className={`radio-opt ${kind === 'delay' ? 'active' : ''}`}>
            <input type="radio" checked={kind === 'delay'} onChange={() => setKind('delay')} /> Running late
          </label>
          <label className={`radio-opt ${kind === 'cancel' ? 'active' : ''}`}>
            <input type="radio" checked={kind === 'cancel'} onChange={() => setKind('cancel')} /> Can't attend at all
          </label>
        </div>
      </div>

      {kind === 'delay' && (
        <div className="frow col"><label>Earliest they can arrive</label>
          <input type="time" value={eta} onChange={(e) => setEta(e.target.value)} style={{ maxWidth: 160 }} />
        </div>
      )}

      <div className="frow col"><label>Reason (optional)</label>
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. flight delayed" style={{ width: '100%' }} />
      </div>

      <div className="btnrow" style={{ marginTop: 8 }}>
        <button className="btn hero" disabled={!pid} onClick={submit}>Find solutions</button>
      </div>
      {demo && (
        <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          <a onClick={loadDemo} style={{ cursor: 'pointer' }}>Demo: load Dr. {demo.name.split(' ').slice(-1)[0]}'s flight delay →</a>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Step 2: options
function OptionsStep({ onBack }: { onBack: () => void }) {
  const { seed, peopleById, fmtMin } = useAgenda();
  const wf = useWorkflow();
  const flow = wf.flow!;
  const dis = flow.disruption;
  const person = peopleById.get(dis.personId);
  const { impact } = generateOptions(seed, dis);

  const [claude, setClaude] = useState({ available: false, model: null as string | null, on: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    proseHealth().then((h) => setClaude((c) => ({ ...c, available: h.available, model: h.model, on: h.available })));
  }, []);

  const choose = async (o: AgentOption) => {
    setBusy(true);
    await wf.chooseOption(o, claude.available && claude.on);
    setBusy(false);
  };

  const firstValidId = flow.options.find((o) => o.valid)?.id;

  return (
    <div>
      <button className="linkback" onClick={onBack}>← Back to Today</button>

      <div className="status-card amber" style={{ marginTop: 6 }}>
        <div className="sc-title">
          {person?.name ?? 'A speaker'} — {dis.kind === 'cancel' ? "can't attend" : `running late (arriving about ${fmtMin(dis.etaMin ?? 0)})`}
        </div>
        <div className="sc-body">
          This affects {impact.sessions.length} session{impact.sessions.length === 1 ? '' : 's'}: {impact.sessions.map((s) => `"${s.title}" at ${s.start}`).join(', ')}.
          {' '}They can be reached by {person?.reachable_email ? 'email' : ''}{person?.reachable_email && person?.reachable_wa_sms ? ' and ' : ''}{person?.reachable_wa_sms ? 'phone' : ''}{!person?.reachable_email && !person?.reachable_wa_sms ? 'no listed channel' : ''}.
        </div>
      </div>

      <div className="section-title">Step 2 · Choose a solution</div>

      <label className={`pill ${claude.on ? 'active' : ''}`}
        style={{ cursor: claude.available ? 'pointer' : 'not-allowed', opacity: claude.available ? 1 : 0.55, marginBottom: 4 }}>
        <input type="checkbox" checked={claude.on} disabled={!claude.available}
          onChange={(e) => setClaude((c) => ({ ...c, on: e.target.checked }))} style={{ marginRight: 6 }} />
        ✨ Draft copy with Claude
      </label>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        {claude.available ? `Claude is available${claude.model ? ` · ${claude.model}` : ''} — it will write the messages sent to people.`
          : 'Claude is offline — the app will use clear ready-made wording instead.'}
      </div>

      {busy && <div className="note">✨ Drafting the wording for everyone affected…</div>}

      {flow.options.map((o) => (
        <OptionCard key={o.id} o={o} recommended={o.id === firstValidId} onChoose={() => choose(o)} disabled={busy} />
      ))}
    </div>
  );
}

function OptionCard({ o, recommended, onChoose, disabled }:
  { o: AgentOption; recommended: boolean; onChoose: () => void; disabled: boolean }) {
  const level = disruptionLevel(o.score);
  return (
    <div className={`optcard ${recommended ? 'rec' : ''} ${o.valid ? '' : 'invalid'}`}>
      <div className="opthead">
        <div>
          <div className="opttitle">{KIND_TITLE[o.kind]}</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{o.title}</div>
        </div>
        <div className="btnrow" style={{ justifyContent: 'flex-end' }}>
          {recommended && <span className="chip published">Recommended — least disruption</span>}
          {o.valid && <span className={`chip ${level.cls}`}>{level.label}</span>}
          {!o.valid && <span className="chip error">Not possible here</span>}
        </div>
      </div>

      <table className="difftab" style={{ marginTop: 10 }}><tbody>
        {o.diff.map((d, i) => (
          <tr key={i}>
            <td className="muted">{d.label}</td>
            <td style={{ textDecoration: 'line-through', opacity: .6 }}>{d.before}</td>
            <td>→</td>
            <td><span className={`dot ${d.tone}`} />{d.after}</td>
          </tr>
        ))}
      </tbody></table>

      <div className="optfoot">
        <span className="muted">Affects {affectedCount(o)} {affectedCount(o) === 1 ? 'person' : 'people'}
          {!o.valid && o.invalidReason ? ` · ${o.invalidReason}` : ''}</span>
        {o.valid && <button className="btn ok" disabled={disabled} onClick={onChoose}>Choose this</button>}
      </div>

      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--muted)' }}>Why this works</summary>
        <div className="fdetail" style={{ marginTop: 6 }}>{o.rationale}</div>
      </details>
    </div>
  );
}
