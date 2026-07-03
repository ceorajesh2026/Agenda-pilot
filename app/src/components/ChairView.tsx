// The Chair's phone. One job: approve or reject the proposed change. Narrow layout.
import { useState } from 'react';
import { useAgenda } from '../lib/data';
import { useWorkflow } from '../lib/workflow';
import { KIND_TITLE, affectedCount } from './shared';

export default function ChairView() {
  const { peopleById, fmtMin } = useAgenda();
  const wf = useWorkflow();
  const flow = wf.flow;
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [acted, setActed] = useState<'approved' | 'rejected' | null>(null);

  const pending = flow?.stage === 'chair' && flow.chosen;

  // past decisions from the audit trail (anything the Chair did)
  const decisions = (flow?.audit ?? []).filter((a) => a.actor === 'Neurology Scientific Chair');

  if (!pending) {
    return (
      <div className="chair-wrap">
        {acted && (
          <div className="status-card green">
            <div className="sc-title">{acted === 'approved' ? '✅ Approved' : '✗ Sent back'}</div>
            <div className="sc-body">
              {acted === 'approved'
                ? 'Sent to the Secretariat for final sign-off — switch back to the Secretariat view.'
                : 'Your note has been sent to the Secretariat — they will pick another option.'}
            </div>
          </div>
        )}
        <div className="card" style={{ textAlign: 'center', padding: 28 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Nothing is waiting for your approval.</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            When the organizing team proposes a schedule change, it appears here.
          </div>
        </div>
        {decisions.length > 0 && (
          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--muted)' }}>Past decisions ({decisions.length})</summary>
            <div className="timeline" style={{ marginTop: 10 }}>
              {decisions.map((d, i) => (
                <div className="tl" key={i}>
                  <span className="tlt">{d.at}</span>
                  <span className="tla">You</span>
                  <span className="tlx">{d.text}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    );
  }

  const o = flow.chosen!;
  const dis = flow.disruption;
  const person = peopleById.get(dis.personId);
  const hallHint = o.diff[0]?.label ?? '';
  const affectedNames = [...new Set(o.notifications.map((n) => n.to))].join(', ');

  const approve = (edited?: boolean) => { wf.chairApprove(edited); setActed('approved'); };
  const reject = () => {
    wf.chairReject(note.trim() || 'Please look at another option');
    setActed('rejected'); setRejecting(false); setNote('');
  };

  return (
    <div className="chair-wrap">
      <div className="status-card blue">
        <div className="sc-title">Approval needed</div>
        <div className="sc-body">
          {person?.name ?? 'A speaker'} is {dis.kind === 'cancel' ? 'unable to attend' : `delayed${dis.etaMin != null ? ` (arriving about ${fmtMin(dis.etaMin)})` : ''}`} —
          proposal: <strong>{KIND_TITLE[o.kind].toLowerCase()}</strong>{hallHint ? ` (${hallHint})` : ''}.
        </div>
      </div>

      <table className="difftab" style={{ marginTop: 12 }}>
        <thead><tr><th>What</th><th>Current</th><th></th><th>Proposed</th></tr></thead>
        <tbody>
          {o.diff.map((d, i) => (
            <tr key={i}>
              <td className="muted">{d.label}</td>
              <td style={{ opacity: .6 }}>{d.before}</td>
              <td>→</td>
              <td><span className={`dot ${d.tone}`} />{d.after}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="fdetail" style={{ margin: '10px 0' }}>
        <strong>Affects:</strong> {affectedNames} ({affectedCount(o)} people).
      </div>
      <div className="fdetail" style={{ marginBottom: 14 }}>{o.rationale}</div>
      {o.llm && <div style={{ marginBottom: 10 }}><span className="chip published">✨ Wording drafted by Claude</span></div>}

      <div className="chair-actions">
        <button className="btn ok full" onClick={() => approve()}>✓ Approve</button>
        <button className="btn full" onClick={() => approve(true)}>Approve with edits</button>
        {!rejecting && <button className="btn bad full" onClick={() => setRejecting(true)}>✗ Reject</button>}
        {rejecting && (
          <div className="card" style={{ padding: 12 }}>
            <textarea value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Tell the team why (e.g. prefer the backup speaker)…"
              style={{ width: '100%', minHeight: 70 }} />
            <div className="btnrow" style={{ marginTop: 8 }}>
              <button className="btn bad" onClick={reject}>Send rejection</button>
              <button className="btn" onClick={() => setRejecting(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
