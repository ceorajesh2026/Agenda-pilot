// AgendaPilot server — the M3 prose seam + the M4 distribution backend.
//
//   M3: POST /api/prose            -> Claude writes rationale + notification copy (strict tool use)
//   M4: POST /api/publish          -> apply an approved revision, propagate to all channels
//       GET  /api/public/agenda.json  public JSON feed (website / any consumer)   [CORS *]
//       GET  /api/public/widget.js    single-script-tag embeddable agenda widget  [CORS *]
//       GET  /api/public/embed        iframe-friendly HTML agenda                  [CORS *]
//       GET  /api/ics/agenda.ics      whole-event calendar feed                    [CORS *]
//       GET  /api/ics/person/:id.ics  per-person auto-updating calendar feed       [CORS *]
//       GET  /api/print/day/:date     print-ready day program (Ctrl+P -> PDF)
//       GET  /api/pdf/:name           stream a generated revised-agenda PDF (inline)
//       GET  /api/outbox              simulated email outbox (personal + broadcast)
//       GET  /api/whatsapp            simulated WhatsApp group feed
//       GET  /api/changelog           revisions + publication log
//
// The published agenda = seed.json with approved revisions applied on top. Feeds are derived
// on demand, so website/ICS/print are always consistent the instant a revision is published.
// On publish the server also mints a real PDF of the revised day + a simulated email/WhatsApp blast.
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(fs.readFileSync(path.join(HERE, '../src/data/seed.json'), 'utf8'));
const GENERATED_DIR = path.join(HERE, 'generated');
const PORT = process.env.PORT || 8787;
const MODEL = process.env.AGENDAPILOT_MODEL || 'claude-opus-4-8';
const hasKey = !!process.env.ANTHROPIC_API_KEY;
const client = hasKey ? new Anthropic() : null;

const PEOPLE = new Map(SEED.people.map((p) => [p.id, p]));
const app = express();
app.use(express.json({ limit: '512kb' }));

// ---------------------------------------------------------------- distribution state
let revisions = [];      // {id, at, kind, title, summary, delta, actor}
let publications = [];    // {id, revision_id, at, targets[], notifications[], whatsapp, pdfUrl, pdfName}
let outbox = [];          // simulated email outbox: {id, at, kind:'personal'|'broadcast', ...}
let whatsappFeed = [];    // simulated WhatsApp group posts: {id, at, group, text, pdfName, pdfUrl}
let seq = 0;
const nid = (p) => `${p}${++seq}`;
const now = () => new Date().toISOString();

// notification idempotency + a simple rate limiter (no accidental blast)
const sentKeys = new Set();
const RATE = { max: 30, windowMs: 10000, hits: [] };
function rateOk() {
  const t = Date.now();
  RATE.hits = RATE.hits.filter((h) => t - h < RATE.windowMs);
  if (RATE.hits.length >= RATE.max) return false;
  RATE.hits.push(t);
  return true;
}

function hhmm(m) { return m == null ? null : `${String((m / 60) | 0).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }

// apply approved revisions on top of the seed -> the current published agenda
function publishedAgenda() {
  const sessions = SEED.sessions.map((s) => ({ ...s }));
  const roles = SEED.roles.map((r) => ({ ...r }));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const revCount = new Map();
  for (const rev of revisions) {
    for (const op of rev.delta || []) {
      revCount.set(op.sessionId, (revCount.get(op.sessionId) || 0) + 1);
      const s = byId.get(op.sessionId);
      if (op.op === 'reschedule' && s) {
        s.start_min = op.start_min; s.end_min = op.end_min; s.start = hhmm(op.start_min); s.end = hhmm(op.end_min);
        s.state = 'REVISED'; s.revised = true; s.revised_at = rev.at;
      } else if (op.op === 'substitute') {
        for (const r of roles) if (r.session_id === op.sessionId && r.person_id === op.fromPersonId) r.person_id = op.toPersonId;
        if (s) { s.state = 'REVISED'; s.revised = true; s.revised_at = rev.at; }
      } else if (op.op === 'absorb' && s) {
        s.state = 'CANCELLED'; s.cancelled = true; s.revised = true; s.revised_at = rev.at;
      }
    }
  }
  return { sessions, roles, revCount };
}

function speakersOf(sessionId, roles) {
  const names = [];
  for (const r of roles) {
    if (r.session_id !== sessionId) continue;
    const nm = r.person_id ? (PEOPLE.get(r.person_id)?.name ?? r.name_raw) : r.name_raw;
    if (nm && !names.includes(nm)) names.push(nm);
  }
  return names;
}

function feedSessions() {
  const { sessions, roles, revCount } = publishedAgenda();
  const halls = new Map(SEED.halls.map((h) => [h.id, h.name]));
  return sessions
    .filter((s) => s.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.start_min ?? 9999) - (b.start_min ?? 9999)))
    .map((s) => ({
      id: s.id, track: s.track === 'neurology' ? 'Neurology' : s.track, day: s.date,
      hall: halls.get(s.hall_id) ?? s.hall_id, title: s.title, type: s.type,
      start: s.start, end: s.end, state: s.state, revised: !!s.revised, revised_at: s.revised_at ?? null,
      cancelled: !!s.cancelled, speakers: speakersOf(s.id, roles), _revs: revCount.get(s.id) || 0, start_min: s.start_min, end_min: s.end_min,
    }));
}

const lastUpdated = () => (publications.length ? publications[publications.length - 1].at : SEED.event.start_date);

// ---------------------------------------------------------------- lookups shared by feeds + PDF
const dayLabel = (date) => (SEED.days.find((d) => d.date === date)?.label ?? date);

// ---------------------------------------------------------------- CORS for public feeds
const cors = (_req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); };

// ---------------------------------------------------------------- public JSON feed
app.get('/api/public/agenda.json', cors, (_req, res) => {
  res.json({
    event: SEED.event, generated: now(), last_updated: lastUpdated(),
    days: SEED.days, halls: SEED.halls.map((h) => h.name),
    sessions: feedSessions().map(({ _revs, start_min, end_min, ...pub }) => { void _revs; void start_min; void end_min; return pub; }),
  });
});

// ---------------------------------------------------------------- embeddable widget (one <script> tag)
app.get('/api/public/widget.js', cors, (_req, res) => {
  res.type('application/javascript').send(`(function(){
  var s=document.currentScript, base=(s&&s.src||'').replace(/\\/api\\/public\\/widget\\.js.*/,'');
  var host=document.getElementById('agendapilot')||document.body.appendChild(document.createElement('div'));
  host.innerHTML='<p style="font:13px system-ui;color:#888">Loading WNS 2026 agenda…</p>';
  fetch(base+'/api/public/agenda.json').then(function(r){return r.json()}).then(function(d){
    var css='font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:0 auto';
    var h='<div style="'+css+'"><div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #222;padding-bottom:8px"><strong style="font-size:18px">'+d.event.name+'</strong><span style="font-size:11px;color:#888">Updated '+new Date(d.last_updated).toLocaleString()+'</span></div>';
    var curDay='';
    d.sessions.forEach(function(x){
      if(x.day!==curDay){curDay=x.day;h+='<h3 style="margin:16px 0 6px;font-size:14px">'+(d.days.filter(function(y){return y.date===x.day})[0]||{}).label+'</h3>'}
      var badge=x.revised?' <span style="background:#d29922;color:#fff;font-size:10px;padding:1px 6px;border-radius:8px">REVISED</span>':'';
      var when=x.start?(x.start+'–'+x.end):'';
      h+='<div style="display:flex;gap:10px;padding:6px 0;border-top:1px solid #eee"><span style="min-width:96px;color:#4c8dff;font-variant-numeric:tabular-nums">'+when+'</span><span><strong>'+x.title+'</strong>'+badge+(x.speakers.length?'<br><span style="color:#888;font-size:12px">'+x.speakers.join(', ')+'</span>':'')+'<br><span style="color:#aaa;font-size:11px">'+x.hall+'</span></span></div>';
    });
    host.innerHTML=h+'</div>';
  }).catch(function(){host.innerHTML='<p style="color:#c00">Agenda unavailable.</p>'});
})();`);
});

// ---------------------------------------------------------------- iframe embed
app.get('/api/public/embed', cors, (_req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WNS 2026 Agenda</title></head><body style="margin:0;padding:16px;background:#fff"><div id="agendapilot"></div><script src="/api/public/widget.js"></script></body></html>`);
});

// ---------------------------------------------------------------- ICS feeds
function icsDate(date, min) {
  const d = date.replaceAll('-', '');
  const hh = String((min / 60) | 0).padStart(2, '0'); const mm = String(min % 60).padStart(2, '0');
  return `${d}T${hh}${mm}00`;
}
function esc(t) { return String(t).replace(/[\\,;]/g, (m) => '\\' + m).replace(/\n/g, '\\n'); }
function buildIcs(filterPersonId) {
  const { sessions, roles, revCount } = publishedAgenda();
  const halls = new Map(SEED.halls.map((h) => [h.id, h.name]));
  const stamp = now().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AgendaPilot//WNS2026//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:WNS 2026', 'X-WR-TIMEZONE:Asia/Kolkata'];
  for (const s of sessions) {
    if (!s.date || s.start_min == null || s.end_min == null || s.cancelled) continue;
    if (filterPersonId && !roles.some((r) => r.session_id === s.id && r.person_id === filterPersonId)) continue;
    const spk = speakersOf(s.id, roles);
    lines.push('BEGIN:VEVENT',
      `UID:${s.id}@worldneurosciencessummit.com`,
      `DTSTAMP:${stamp}`,
      `SEQUENCE:${revCount.get(s.id) || 0}`,
      `DTSTART:${icsDate(s.date, s.start_min)}`,
      `DTEND:${icsDate(s.date, s.end_min)}`,
      `SUMMARY:${esc(s.title + (s.revised ? ' (revised)' : ''))}`,
      `LOCATION:${esc(halls.get(s.hall_id) ?? '')}`,
      `DESCRIPTION:${esc((spk.length ? spk.join(', ') : 'WNS 2026') + (s.revised ? ' — schedule revised' : ''))}`,
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
app.get('/api/ics/agenda.ics', cors, (_req, res) => res.type('text/calendar').send(buildIcs(null)));
app.get('/api/ics/person/:id.ics', cors, (req, res) => res.type('text/calendar').send(buildIcs(req.params.id)));

// ---------------------------------------------------------------- print-ready day program
app.get('/api/print/day/:date', (req, res) => {
  const date = req.params.date;
  const day = SEED.days.find((d) => d.date === date);
  const rows = feedSessions().filter((s) => s.day === date).map((s) => `<tr class="${s.revised ? 'rev' : ''}"><td class="t">${s.start ? s.start + '–' + s.end : ''}</td><td><strong>${s.title}</strong>${s.revised ? ' <span class="badge">REVISED</span>' : ''}${s.cancelled ? ' <span class="badge cx">CANCELLED</span>' : ''}${s.speakers.length ? '<div class="spk">' + s.speakers.join(', ') + '</div>' : ''}</td><td>${s.hall}</td></tr>`).join('');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf8"><title>WNS 2026 — ${day ? day.label : date}</title><style>
    body{font-family:Georgia,serif;max-width:820px;margin:24px auto;color:#111}
    h1{font-size:20px;margin:0} .sub{color:#666;font-size:12px;margin:2px 0 16px}
    table{width:100%;border-collapse:collapse} td{padding:7px 8px;border-bottom:1px solid #ddd;vertical-align:top;font-size:13px}
    .t{white-space:nowrap;color:#0a58ca;font-variant-numeric:tabular-nums;width:110px} .spk{color:#666;font-size:12px;margin-top:2px}
    .badge{background:#d29922;color:#fff;font-size:10px;padding:1px 6px;border-radius:8px;font-family:sans-serif} .badge.cx{background:#c0392b}
    tr.rev td{background:#fff8e6} .print{margin:16px 0;font-family:sans-serif;font-size:13px}
    @media print{.print{display:none}}
  </style></head><body>
    <h1>${SEED.event.name}</h1><div class="sub">${day ? day.label : date} · printable program · generated ${new Date().toLocaleString()}</div>
    <div class="print">📄 Press <b>Ctrl/Cmd + P</b> → “Save as PDF” for the registration desk.</div>
    <table><thead><tr><td class="t"><b>Time</b></td><td><b>Session</b></td><td><b>Hall</b></td></tr></thead><tbody>${rows || '<tr><td colspan=3>No sessions.</td></tr>'}</tbody></table>
  </body></html>`);
});

// ---------------------------------------------------------------- publish (propagate a revision)
function deliver(n, revId) {
  const key = `${revId}|${n.to}|${n.channel}`;
  if (sentKeys.has(key)) return { ...n, status: 'deduped', attempts: 0 };
  if (!rateOk()) return { ...n, status: 'rate_limited', attempts: 0 };
  sentKeys.add(key);
  // Real Meta/Twilio/SES adapters plug in here. phone-call = no digital channel -> desk must call.
  const status = n.channel === 'phone-call' ? 'needs_call' : 'sent';
  return { ...n, status, attempts: 1 };
}

// ---------------------------------------------------------------- PDF: the revised-agenda document
// Renders the day program to A4 (Helvetica). `changes` = [{title, oldRange, newRange, hall}] captured
// pre-publish so old->new times are correct. `rows` = feedSessions() for the day (post-publish state).
function renderAgendaPdf(filePath, { version, dayDate, summary, changes, rows }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const stream = fs.createWriteStream(filePath);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.on('error', reject);
    doc.pipe(stream);

    const label = dayLabel(dayDate);
    const LEFT = doc.page.margins.left;
    const RIGHT = doc.page.width - doc.page.margins.right;
    const CONTENT_W = RIGHT - LEFT;
    const BOTTOM = doc.page.height - doc.page.margins.bottom; // ~793 on A4
    const AMBER = '#fff3cd';

    // ---- header
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#111').text('WNS 2026 — Revised Agenda', LEFT, doc.y);
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(11).fillColor('#444').text('World Neurosciences Summit 2026');
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text(label);
    doc.font('Helvetica').fontSize(9).fillColor('#666')
      .text(`Published ${new Date().toLocaleString()}   ·   Version ${version}`);
    doc.moveTo(LEFT, doc.y + 4).lineTo(RIGHT, doc.y + 4).strokeColor('#222').lineWidth(1.5).stroke();
    doc.moveDown(1);

    // ---- WHAT CHANGED
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111').text('WHAT CHANGED');
    doc.moveDown(0.3);
    if (summary) {
      doc.font('Helvetica').fontSize(10).fillColor('#333').text(summary, { width: CONTENT_W });
      doc.moveDown(0.4);
    }
    if (changes.length) {
      for (const c of changes) {
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#8a5a00');
        doc.text('•  ', LEFT, doc.y, { continued: true }).text(`"${c.title}"`, { continued: true });
        doc.font('Helvetica').fillColor('#333')
          // "->" not "→": U+2192 is outside WinAnsi, so pdfkit's built-in Helvetica garbles it
          .text(` — ${c.oldRange || 'TBD'} -> ${c.newRange || 'TBD'}, ${c.hall}`, { width: CONTENT_W });
      }
    } else {
      doc.font('Helvetica').fontSize(10).fillColor('#666').text('No individual session changes recorded.');
    }
    doc.moveDown(1);

    // ---- PROGRAM
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111').text(`PROGRAM — ${label}`);
    doc.moveDown(0.5);

    const TIME_W = 92;
    const HALL_W = 150;
    const TITLE_X = LEFT + TIME_W;
    const HALL_X = RIGHT - HALL_W;
    const TITLE_W = HALL_X - TITLE_X - 10;

    const ensureRoom = (need) => {
      if (doc.y + need > BOTTOM) {
        doc.addPage();
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#999')
          .text(`PROGRAM — ${label} (cont.)`, LEFT, doc.page.margins.top);
        doc.moveDown(0.6);
      }
    };

    if (!rows.length) {
      doc.font('Helvetica').fontSize(10).fillColor('#666').text('No sessions scheduled for this day.');
    }
    for (const s of rows) {
      const when = s.start ? `${s.start}–${s.end}` : '';
      let titleLine = s.title;
      if (s.cancelled) titleLine += ' (CANCELLED)';
      else if (s.revised) titleLine += ' (REVISED)';
      const spk = s.speakers && s.speakers.length ? s.speakers.join(', ') : '';

      // measure the row height so highlight rect + page-break math line up
      const titleH = doc.font('Helvetica-Bold').fontSize(10).heightOfString(titleLine, { width: TITLE_W });
      const spkH = spk ? doc.font('Helvetica').fontSize(8).heightOfString(spk, { width: TITLE_W }) : 0;
      const rowH = Math.max(titleH + (spk ? spkH + 2 : 0), 14) + 8;

      ensureRoom(rowH);
      const rowTop = doc.y;

      if (s.revised && !s.cancelled) {
        doc.save().rect(LEFT - 4, rowTop - 3, CONTENT_W + 8, rowH).fill(AMBER).restore();
      }

      doc.font('Helvetica').fontSize(9).fillColor('#0a58ca').text(when, LEFT, rowTop + 1, { width: TIME_W - 6 });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(s.cancelled ? '#c0392b' : '#111')
        .text(titleLine, TITLE_X, rowTop, { width: TITLE_W });
      if (spk) doc.font('Helvetica').fontSize(8).fillColor('#777').text(spk, TITLE_X, doc.y + 1, { width: TITLE_W });
      doc.font('Helvetica').fontSize(8).fillColor('#555').text(s.hall || '', HALL_X, rowTop + 1, { width: HALL_W });

      doc.y = rowTop + rowH;
      doc.x = LEFT;
      doc.moveTo(LEFT, doc.y - 3).lineTo(RIGHT, doc.y - 3).strokeColor('#eee').lineWidth(0.5).stroke();
    }

    doc.end();
  });
}

app.post('/api/publish', async (req, res) => {
  const { kind, title, summary, delta = [], notifications = [], actor = 'Secretariat' } = req.body ?? {};

  // --- capture PRE-publish session state so the PDF can show old -> new times.
  const preFeed = feedSessions();
  const preById = new Map(preFeed.map((s) => [s.id, s]));

  // resolve the affected day: explicit body.dayDate, else the date of the first session in the delta.
  let dayDate = req.body?.dayDate;
  if (!dayDate) {
    for (const op of delta) {
      const s = preById.get(op.sessionId);
      if (s?.day) { dayDate = s.day; break; }
    }
  }
  if (!dayDate) dayDate = SEED.days[0].date;

  const rev = { id: nid('rev'), at: now(), kind, title, summary, delta, actor };
  revisions.push(rev);
  const version = revisions.length + 1;

  const delivered = notifications.map((n) => deliver(n, rev.id));
  const acked = 0;

  // --- POST-publish feed (revision applied). Changed sessions = ids referenced in the delta.
  const feed = feedSessions();
  const changed = feed.filter((s) => delta.some((op) => op.sessionId === s.id));
  const dayRows = feed.filter((s) => s.day === dayDate);

  // old -> new time diff for the "WHAT CHANGED" section (pre times from preById, new times from feed).
  const changes = changed.map((s) => {
    const before = preById.get(s.id);
    const oldRange = before && before.start ? `${before.start}–${before.end}` : null;
    const newRange = s.start ? `${s.start}–${s.end}` : null;
    return { id: s.id, title: s.title, oldRange, newRange, hall: s.hall };
  });

  // --- mint the revised-agenda PDF (await the stream finishing before responding).
  const pdfName = `revised-agenda-v${version}-${dayDate}.pdf`;
  const pdfUrl = `/api/pdf/${pdfName}`;
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const pdfPath = path.join(GENERATED_DIR, pdfName);
  try {
    await renderAgendaPdf(pdfPath, { version, dayDate, summary, changes, rows: dayRows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'pdf_failed', detail: String(err?.message ?? err) });
  }

  // whatsapp group summary (formatted change post)
  const whatsapp = ['🔔 *Agenda update — ' + SEED.event.name + '*', summary ? '_' + summary + '_' : '', ...changed.map((s) => `• "${s.title}" → now ${s.start ? s.start + '–' + s.end : 'TB—'}, ${s.hall}${s.revised ? ' (revised)' : ''}`), 'Live agenda: /api/public/embed'].filter(Boolean).join('\n');

  // --- (2a) simulated outbox: one personal email per notification.
  const secretariatSig = '\n— WNS 2026 Secretariat';
  for (const n of notifications) {
    const person = n.personId ? PEOPLE.get(n.personId) : null;
    const address = (person && person.emails && person.emails[0]) || null;
    const subject = 'WNS 2026 — your schedule has changed';
    const body = (n.message || '') + '\n\nThe full revised agenda is attached (PDF).' + secretariatSig;
    const mailto = 'mailto:' + (address || '') + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    outbox.push({
      id: nid('mail'), at: rev.at, kind: 'personal',
      to: n.to, address, personId: n.personId ?? null, channel: n.channel, critical: !!n.critical,
      subject, body, pdfUrl, pdfName, mailto,
    });
  }

  // --- (2b) simulated outbox: one broadcast email to all faculty + delegates, PDF attached.
  const reachable = SEED.people.filter((p) => p.reachable_email);
  const toCount = reachable.length + 1; // +1 = delegates mailing list (via registration vendor)
  const sample = [...reachable.slice(0, 5).map((p) => p.name), 'Delegates mailing list (via registration vendor)'];
  const bSubject = `WNS 2026 — Revised agenda (v${version})`;
  const changeBullets = changed.map((s) => `• "${s.title}" → ${s.start ? s.start + '–' + s.end : 'TBD'}, ${s.hall}`).join('\n');
  const bBody = (summary || '') + '\n\nChanges:\n' + changeBullets + '\n\nThe revised agenda is attached as a PDF.' + secretariatSig;
  const bMailto = 'mailto:' + '?subject=' + encodeURIComponent(bSubject) + '&body=' + encodeURIComponent(bBody);
  outbox.push({
    id: nid('mail'), at: rev.at, kind: 'broadcast',
    to: 'All faculty + delegates', toCount, sample,
    subject: bSubject, body: bBody, pdfUrl, pdfName, mailto: bMailto,
  });

  // --- (3) simulated WhatsApp group post with the PDF attachment card.
  whatsappFeed.push({ id: nid('wa'), at: rev.at, group: 'WNS 2026 — Faculty & Delegates', text: whatsapp, pdfName, pdfUrl });

  const targets = [
    { name: 'Website feed', channel: 'website', status: 'refreshed', detail: '/api/public/agenda.json', attempts: 1 },
    { name: 'Embed widget', channel: 'website', status: 'refreshed', detail: '/api/public/widget.js', attempts: 1 },
    { name: 'ICS calendars', channel: 'ics', status: 'refreshed', detail: '/api/ics/agenda.ics', attempts: 1 },
    { name: 'Revised PDF', channel: 'pdf', status: 'generated', detail: pdfUrl, attempts: 1 },
    { name: 'Email outbox', channel: 'email', status: 'queued', detail: `${notifications.length} personal + 1 broadcast (${toCount})`, attempts: 1 },
    { name: 'Print program', channel: 'print', status: 'refreshed', detail: '/api/print/day/' + dayDate, attempts: 1 },
    { name: 'WhatsApp groups', channel: 'whatsapp', status: rateOk() ? 'posted' : 'rate_limited', detail: 'Faculty + Delegates', attempts: 1 },
  ];

  const pub = { id: nid('pub'), revision_id: rev.id, at: rev.at, title, summary, targets, notifications: delivered, acked, whatsapp, pdfUrl, pdfName };
  publications.push(pub);
  res.json({ ok: true, publication: pub, version, last_updated: rev.at });
});

// ---------------------------------------------------------------- stream a generated PDF (inline)
app.get('/api/pdf/:name', (req, res) => {
  const name = path.basename(req.params.name);            // strip any path segments
  const filePath = path.resolve(GENERATED_DIR, name);
  // confirm the resolved path stays inside the generated dir
  const rel = path.relative(GENERATED_DIR, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.type('application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ---------------------------------------------------------------- simulated email outbox
app.get('/api/outbox', (_req, res) => res.json({ emails: [...outbox].reverse() }));

// ---------------------------------------------------------------- simulated WhatsApp group feed
app.get('/api/whatsapp', (_req, res) => res.json({ posts: [...whatsappFeed].reverse() }));

// ---------------------------------------------------------------- change + notification log
app.get('/api/changelog', (_req, res) => {
  res.json({
    version: revisions.length + 1, last_updated: lastUpdated(),
    publications: [...publications].reverse().map((p) => ({
      id: p.id, at: p.at, title: p.title, summary: p.summary,
      targets: p.targets.map((t) => ({ name: t.name, status: t.status, detail: t.detail })),
      notifications: p.notifications.map((n) => ({ to: n.to, channel: n.channel, status: n.status })),
      whatsapp: p.whatsapp, pdfUrl: p.pdfUrl, pdfName: p.pdfName,
    })),
    feeds: { json: '/api/public/agenda.json', widget: '/api/public/widget.js', embed: '/api/public/embed', ics: '/api/ics/agenda.ics', print: SEED.days.map((d) => ({ date: d.date, label: d.label, url: '/api/print/day/' + d.date })) },
  });
});

// reset (demo convenience) — also clears the outbox, WhatsApp feed, and generated PDFs.
app.post('/api/reset', (_req, res) => {
  revisions = []; publications = []; outbox = []; whatsappFeed = []; sentKeys.clear();
  try {
    if (fs.existsSync(GENERATED_DIR)) {
      for (const f of fs.readdirSync(GENERATED_DIR)) {
        try { fs.unlinkSync(path.join(GENERATED_DIR, f)); } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort */ }
  res.json({ ok: true });
});

// ---------------------------------------------------------------- M3 prose seam (unchanged)
app.get('/api/prose/health', (_req, res) => res.json({ available: hasKey, model: hasKey ? MODEL : null }));

const SYSTEM = `You are AgendaPilot, the operations copywriter for a large medical conference
(the World Neurosciences Summit). A session change has ALREADY been decided and validated by a
constraint checker; your only job is to write the human-facing copy for it.

Rules:
- Use ONLY the facts provided. Never invent times, halls, names, or reasons.
- Rationale: 2-3 sentences, plain language, for a Scientific Chair deciding whether to approve.
- Notification messages: one per recipient, addressed to that person/role, WhatsApp-length
  (1-2 sentences). State exactly what changes for THEM. Warm, precise, no fluff. End speaker/faculty
  messages by asking them to acknowledge. No greetings like "Dear Dr." and no signatures.
- Return every recipient id you were given, exactly once.`;

const PROSE_TOOL = {
  name: 'emit_prose', description: 'Return the rationale and the per-recipient notification messages.', strict: true,
  input_schema: {
    type: 'object',
    properties: {
      rationale: { type: 'string' },
      notifications: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, message: { type: 'string' } }, required: ['id', 'message'], additionalProperties: false } },
    },
    required: ['rationale', 'notifications'], additionalProperties: false,
  },
};

app.post('/api/prose', async (req, res) => {
  if (!client) return res.status(503).json({ error: 'no_api_key' });
  try {
    const message = await client.messages.create({
      model: MODEL, max_tokens: 1024, system: SYSTEM, tools: [PROSE_TOOL],
      tool_choice: { type: 'tool', name: 'emit_prose' },
      messages: [{ role: 'user', content: 'Write the copy for this validated change:\n\n' + JSON.stringify(req.body ?? {}, null, 2) }],
    });
    const block = message.content.find((b) => b.type === 'tool_use');
    if (!block) return res.status(502).json({ error: 'no_tool_use' });
    return res.json(block.input);
  } catch (err) {
    const status = err?.status && err.status >= 400 && err.status < 600 ? 502 : 500;
    return res.status(status).json({ error: 'claude_error', detail: String(err?.message ?? err) });
  }
});

app.listen(PORT, () => {
  console.log(`[agendapilot] server on :${PORT} — model ${MODEL} — key ${hasKey ? 'present' : 'MISSING (prose falls back to templates)'} — ${SEED.sessions.length} sessions loaded`);
});
