// Everything that left the building: emails, WhatsApp posts, the change log and the
// website/calendar links. All fetched from the distribution server; degrades to a
// single friendly note when it's offline.
import { useEffect, useState } from 'react';
import { useAgenda } from '../../lib/data';
import { getChangelog, getOutbox, getWhatsapp } from '../../lib/publish';
import type { Changelog, Outbox, Whatsapp, OutboxEmail, DeliveryStatus } from '../../lib/publish';

// Maps a delivery status to a chip class + label. Null-safe: a missing status reads as
// 'simulated' (older records / offline server never populated it).
const DELIVERY_META: Record<DeliveryStatus, { chip: string; label: string }> = {
  simulated:    { chip: 'track',     label: 'simulated' },
  sent:         { chip: 'published', label: 'sent' },
  sent_test:    { chip: 'info',      label: 'sent to test inbox' },
  skipped_test: { chip: 'track',     label: 'skipped (test mode)' },
  failed:       { chip: 'error',     label: 'failed' },
  no_address:   { chip: 'warning',   label: 'no email address' },
  partial:      { chip: 'warning',   label: 'partially sent' },
};

function DeliveryChip({ email }: { email: OutboxEmail }) {
  const status: DeliveryStatus = email.delivery_status ?? 'simulated';
  const meta = DELIVERY_META[status] ?? DELIVERY_META.simulated;
  const showDetail = (status === 'failed' || status === 'partial') && !!email.delivery_detail;
  return (
    <span className="delivery-chip-wrap">
      <span className={`chip ${meta.chip}`} title={email.delivery_detail || undefined}>{meta.label}</span>
      {email.delivered_at && (
        <span className="muted" style={{ fontSize: 11 }}>{new Date(email.delivered_at).toLocaleTimeString()}</span>
      )}
      {showDetail && (
        <span className="muted" style={{ fontSize: 11, color: 'var(--red)' }}>{email.delivery_detail}</span>
      )}
    </span>
  );
}

export default function Activity() {
  const { confId } = useAgenda();
  const [cl, setCl] = useState<Changelog | null | undefined>(undefined);
  const [ob, setOb] = useState<Outbox | null>(null);
  const [wa, setWa] = useState<Whatsapp | null>(null);

  const load = () => {
    getChangelog(confId).then(setCl);
    getOutbox(confId).then(setOb);
    getWhatsapp(confId).then(setWa);
  };
  useEffect(load, [confId]);

  if (cl === undefined) return <p className="muted">Loading activity…</p>;
  if (cl === null) {
    return (
      <div className="note">
        The distribution server isn't reachable yet. Approvals still work; publishing will be
        saved locally and go out once the server is running.
      </div>
    );
  }

  const snippet = cl.feeds?.widget
    ? `<script src="${cl.feeds.widget}"></script>\n<div id="agendapilot"></div>`
    : '<!-- Publish a change to generate the embed snippet -->';

  return (
    <div>
      <div className="controls">
        <span className="muted">Agenda version v{cl.version} · updated {new Date(cl.last_updated).toLocaleString()}</span>
        <button className="btn sm" onClick={load}>Refresh</button>
      </div>

      {/* -------- outbox -------- */}
      <div className="section-title">📤 Outbox</div>
      {(!ob || ob.emails.length === 0) && <p className="muted">No emails yet — they appear here after a change is published.</p>}
      {ob?.emails.map((e) => (
        <div className="session" key={e.id}>
          <div className="shead">
            <span className={`chip ${e.kind === 'broadcast' ? 'info' : 'published'}`}>{e.kind}</span>
            <DeliveryChip email={e} />
            <span className="muted" style={{ fontSize: 12 }}>
              To: {e.to}{e.toCount ? ` (${e.toCount} recipients)` : ''}
            </span>
            <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>{new Date(e.at).toLocaleTimeString()}</span>
          </div>
          <div style={{ fontWeight: 700, margin: '6px 0 2px' }}>{e.subject}</div>
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--muted)' }}>Read the message</summary>
            <div className="fdetail" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{e.body}</div>
          </details>
          <div className="btnrow" style={{ marginTop: 8 }}>
            {e.pdfUrl && <a className="btn sm" href={e.pdfUrl} target="_blank" rel="noreferrer">📄 PDF</a>}
            {e.mailto && <a className="btn sm" href={e.mailto}>Open in mail app</a>}
          </div>
        </div>
      ))}

      {/* -------- whatsapp -------- */}
      <div className="section-title">💬 WhatsApp group</div>
      {(!wa || wa.posts.length === 0) && <p className="muted">No group posts yet.</p>}
      {wa?.posts.map((p) => (
        <div className="wa-bubble" key={p.id}>
          <div className="wa-group">{p.group}</div>
          <div className="wa-text">{p.text}</div>
          {p.pdfUrl && (
            <a className="wa-attach" href={p.pdfUrl} target="_blank" rel="noreferrer">
              📄 {p.pdfName ?? 'Revised agenda.pdf'}
            </a>
          )}
          <div className="wa-time">{new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
      ))}

      {/* -------- change log -------- */}
      <div className="section-title">📜 Change log</div>
      {cl.publications.length === 0 && <p className="muted">No changes published yet.</p>}
      {cl.publications.map((p) => (
        <div className="session" key={p.id}>
          <div className="shead">
            <span className="stitle">{p.title}</span>
            <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>{new Date(p.at).toLocaleTimeString()}</span>
          </div>
          <div className="meta">{p.summary}</div>
          <div className="btnrow" style={{ margin: '8px 0 0' }}>
            {p.targets.map((t, i) => (
              <span key={i} className={`chip ${t.status === 'rate_limited' ? 'warning' : 'published'}`}>{t.name}</span>
            ))}
            {p.pdfUrl && <a className="btn sm" href={p.pdfUrl} target="_blank" rel="noreferrer">📄 PDF</a>}
          </div>
        </div>
      ))}

      {/* -------- website & calendar -------- */}
      <div className="section-title">🔗 Website & calendar links</div>
      <div className="scroll">
        <table><tbody>
          <tr><td>Website feed (live JSON)</td><td><a href={cl.feeds.json} target="_blank" rel="noreferrer">{cl.feeds.json}</a></td></tr>
          <tr><td>Embeddable widget</td><td><a href={cl.feeds.widget} target="_blank" rel="noreferrer">{cl.feeds.widget}</a></td></tr>
          <tr><td>Preview page</td><td><a href={cl.feeds.embed} target="_blank" rel="noreferrer">{cl.feeds.embed}</a></td></tr>
          <tr><td>Full calendar (auto-updating)</td><td><a href={cl.feeds.ics} target="_blank" rel="noreferrer">{cl.feeds.ics}</a></td></tr>
          <tr><td>Print program</td><td>{cl.feeds.print.map((p) => (
            <a key={p.date} href={p.url} target="_blank" rel="noreferrer" style={{ marginRight: 12 }}>{p.label.split(' (')[0]}</a>
          ))}</td></tr>
        </tbody></table>
      </div>
      <div className="section-title">Embed on your conference website (one script tag)</div>
      <pre className="snippet">{snippet}</pre>
    </div>
  );
}
