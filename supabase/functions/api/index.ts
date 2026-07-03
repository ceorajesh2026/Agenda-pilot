// AgendaPilot backend — Supabase Edge Function port of app/server/index.mjs.
//
// One function `api` serving the full multi-conference API. The published agenda =
// seed schedule (from DB) with approved revisions applied on top. Feeds (JSON/ICS/print)
// are derived on demand so they are consistent the instant a revision is published.
// On publish the function mints a real revised-agenda PDF (pdf-lib), uploads it to the
// public ap-pdfs bucket, and records a simulated email outbox + WhatsApp blast.
import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib";
import Anthropic from "npm:@anthropic-ai/sdk";
import { handleImport } from "./import.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = "claude-opus-4-8";
const PDF_BUCKET = "ap-pdfs";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const now = () => new Date().toISOString();
const hhmm = (m: number | null | undefined) =>
  m == null ? null : `${String((m / 60) | 0).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}
function textResp(body: string, contentType: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": contentType, ...CORS } });
}
function slugify(name: string) {
  return String(name || "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 60) || "conference";
}
// Full public function URL. The internal request URL loses the /functions/v1
// prefix and uses http, so build from the known project URL instead.
function fnBase(_req: Request) {
  return `${SUPABASE_URL}/functions/v1/api`;
}
function pdfPublicUrl(path: string) {
  return `${SUPABASE_URL}/storage/v1/object/public/${PDF_BUCKET}/${path}`;
}

// confId may be a uuid or a slug.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function resolveConf(confId: string) {
  const col = UUID_RE.test(confId) ? "id" : "slug";
  const { data } = await admin.from("conferences").select("*").eq(col, confId).maybeSingle();
  return data;
}

type Ctx = {
  conference: any; days: any[]; halls: any[]; people: any[];
  sessions: any[]; slots: any[]; roles: any[]; revisions: any[];
  peopleById: Map<string, any>; hallsById: Map<string, string>;
};

async function loadCtx(conference: any): Promise<Ctx> {
  const cid = conference.id;
  const [days, halls, people, sessions, slots, roles, revisions] = await Promise.all([
    admin.from("days").select("*").eq("conference_id", cid).order("date"),
    admin.from("halls").select("*").eq("conference_id", cid).order("id"),
    admin.from("people").select("*").eq("conference_id", cid),
    admin.from("sessions").select("*").eq("conference_id", cid),
    admin.from("slots").select("*").eq("conference_id", cid).order("ord"),
    admin.from("roles").select("*").eq("conference_id", cid),
    admin.from("revisions").select("*").eq("conference_id", cid).order("at"),
  ]);
  const peopleRows = people.data ?? [];
  const hallRows = halls.data ?? [];
  return {
    conference,
    days: days.data ?? [], halls: hallRows, people: peopleRows,
    sessions: sessions.data ?? [], slots: slots.data ?? [], roles: roles.data ?? [],
    revisions: revisions.data ?? [],
    peopleById: new Map(peopleRows.map((p: any) => [p.id, p])),
    hallsById: new Map(hallRows.map((h: any) => [h.id, h.name])),
  };
}

// apply approved revisions on top of the DB seed -> current published agenda
function publishedAgenda(ctx: Ctx) {
  const sessions = ctx.sessions.map((s) => ({ ...s }));
  const roles = ctx.roles.map((r) => ({ ...r }));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const revCount = new Map<string, number>();
  for (const rev of ctx.revisions) {
    const delta = Array.isArray(rev.delta) ? rev.delta : [];
    for (const op of delta) {
      revCount.set(op.sessionId, (revCount.get(op.sessionId) || 0) + 1);
      const s = byId.get(op.sessionId);
      if (op.op === "reschedule" && s) {
        s.start_min = op.start_min; s.end_min = op.end_min;
        s.start = hhmm(op.start_min); s.end = hhmm(op.end_min);
        s.state = "REVISED"; s.revised = true; s.revised_at = rev.at;
      } else if (op.op === "substitute") {
        for (const r of roles)
          if (r.session_id === op.sessionId && r.person_id === op.fromPersonId) r.person_id = op.toPersonId;
        if (s) { s.state = "REVISED"; s.revised = true; s.revised_at = rev.at; }
      } else if (op.op === "absorb" && s) {
        s.state = "CANCELLED"; s.cancelled = true; s.revised = true; s.revised_at = rev.at;
      }
    }
  }
  return { sessions, roles, revCount };
}

function speakersOf(sessionId: string, roles: any[], peopleById: Map<string, any>) {
  const names: string[] = [];
  for (const r of roles) {
    if (r.session_id !== sessionId) continue;
    const nm = r.person_id ? (peopleById.get(r.person_id)?.name ?? r.name_raw) : r.name_raw;
    if (nm && !names.includes(nm)) names.push(nm);
  }
  return names;
}

function feedSessions(ctx: Ctx) {
  const { sessions, roles, revCount } = publishedAgenda(ctx);
  const halls = ctx.hallsById;
  return sessions
    .filter((s) => s.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.start_min ?? 9999) - (b.start_min ?? 9999)))
    .map((s) => ({
      id: s.id,
      track: s.track === "neurology" ? "Neurology" : s.track,
      day: s.date,
      hall: halls.get(s.hall_id) ?? s.hall_id,
      title: s.title, type: s.type,
      start: s.start ?? hhmm(s.start_min), end: s.end ?? hhmm(s.end_min),
      state: s.state, revised: !!s.revised, revised_at: s.revised_at ?? null,
      cancelled: !!s.cancelled,
      speakers: speakersOf(s.id, roles, ctx.peopleById),
      _revs: revCount.get(s.id) || 0, start_min: s.start_min, end_min: s.end_min,
    }));
}

async function lastUpdated(cid: string, fallback: string) {
  const { data } = await admin.from("publications").select("at").eq("conference_id", cid)
    .order("at", { ascending: false }).limit(1).maybeSingle();
  return data?.at ?? fallback;
}
function dayLabel(ctx: Ctx, date: string) {
  return ctx.days.find((d) => d.date === date)?.label ?? date;
}

function icsDate(date: string, min: number) {
  const d = String(date).replaceAll("-", "");
  const hh = String((min / 60) | 0).padStart(2, "0");
  const mm = String(min % 60).padStart(2, "0");
  return `${d}T${hh}${mm}00`;
}
function esc(t: unknown) {
  return String(t).replace(/[\\,;]/g, (m) => "\\" + m).replace(/\n/g, "\\n");
}
function buildIcs(ctx: Ctx, filterPersonId: string | null) {
  const { sessions, roles, revCount } = publishedAgenda(ctx);
  const halls = ctx.hallsById;
  const stamp = now().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const name = ctx.conference.name || "Conference";
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "PRODID:-//AgendaPilot//" + esc(name) + "//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:" + esc(name), "X-WR-TIMEZONE:Asia/Kolkata",
  ];
  for (const s of sessions) {
    if (!s.date || s.start_min == null || s.end_min == null || s.cancelled) continue;
    if (filterPersonId && !roles.some((r) => r.session_id === s.id && r.person_id === filterPersonId)) continue;
    const spk = speakersOf(s.id, roles, ctx.peopleById);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${s.id}@${ctx.conference.slug || "agendapilot"}`,
      `DTSTAMP:${stamp}`,
      `SEQUENCE:${revCount.get(s.id) || 0}`,
      `DTSTART:${icsDate(s.date, s.start_min)}`,
      `DTEND:${icsDate(s.date, s.end_min)}`,
      `SUMMARY:${esc(s.title + (s.revised ? " (revised)" : ""))}`,
      `LOCATION:${esc(halls.get(s.hall_id) ?? "")}`,
      `DESCRIPTION:${esc((spk.length ? spk.join(", ") : name) + (s.revised ? " - schedule revised" : ""))}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function printDayHtml(ctx: Ctx, date: string) {
  const day = ctx.days.find((d) => d.date === date);
  const rows = feedSessions(ctx).filter((s) => s.day === date).map((s) =>
    `<tr class="${s.revised ? "rev" : ""}"><td class="t">${s.start ? s.start + "-" + s.end : ""}</td><td><strong>${s.title}</strong>${s.revised ? ' <span class="badge">REVISED</span>' : ""}${s.cancelled ? ' <span class="badge cx">CANCELLED</span>' : ""}${s.speakers.length ? '<div class="spk">' + s.speakers.join(", ") + "</div>" : ""}</td><td>${s.hall}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf8"><title>${esc(ctx.conference.name)} - ${day ? day.label : date}</title><style>
    body{font-family:Georgia,serif;max-width:820px;margin:24px auto;color:#111}
    h1{font-size:20px;margin:0} .sub{color:#666;font-size:12px;margin:2px 0 16px}
    table{width:100%;border-collapse:collapse} td{padding:7px 8px;border-bottom:1px solid #ddd;vertical-align:top;font-size:13px}
    .t{white-space:nowrap;color:#0a58ca;font-variant-numeric:tabular-nums;width:110px} .spk{color:#666;font-size:12px;margin-top:2px}
    .badge{background:#d29922;color:#fff;font-size:10px;padding:1px 6px;border-radius:8px;font-family:sans-serif} .badge.cx{background:#c0392b}
    tr.rev td{background:#fff8e6} .print{margin:16px 0;font-family:sans-serif;font-size:13px}
    @media print{.print{display:none}}
  </style></head><body>
    <h1>${esc(ctx.conference.name)}</h1><div class="sub">${day ? day.label : date} &middot; printable program &middot; generated ${new Date().toLocaleString()}</div>
    <div class="print">Press <b>Ctrl/Cmd + P</b> then "Save as PDF" for the registration desk.</div>
    <table><thead><tr><td class="t"><b>Time</b></td><td><b>Session</b></td><td><b>Hall</b></td></tr></thead><tbody>${rows || "<tr><td colspan=3>No sessions.</td></tr>"}</tbody></table>
  </body></html>`;
}

// WinAnsi-safe: pdf-lib's Helvetica only encodes latin1, so map common unicode
// punctuation to ASCII ('->' not the arrow) and drop anything else.
function ascii(s: string) {
  return String(s ?? "")
    .replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/→/g, "->")
    .replace(/[^\x00-\xFF]/g, "");
}

async function renderAgendaPdf(
  ctx: Ctx,
  opts: { version: number; dayDate: string; summary?: string; changes: any[]; rows: any[] },
): Promise<Uint8Array> {
  const { version, dayDate, summary, changes, rows } = opts;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 595.28, PAGE_H = 841.89;
  const MARGIN = 48;
  const LEFT = MARGIN;
  const RIGHT = PAGE_W - MARGIN;
  const CONTENT_W = RIGHT - LEFT;
  const BOTTOM = MARGIN;
  const AMBER = rgb(1, 0.953, 0.804);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const col = (hex: string) => {
    const n = parseInt(hex.replace("#", ""), 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };
  const label = dayLabel(ctx, dayDate);

  const wrap = (s: string, f: any, size: number, width: number) => {
    const words = ascii(s).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (f.widthOfTextAtSize(t, size) > width && cur) { lines.push(cur); cur = w; }
      else cur = t;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  };
  const drawText = (s: string, x: number, yy: number, f: any, size: number, color: any) =>
    page.drawText(ascii(s), { x, y: yy, size, font: f, color });

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
    drawText(`PROGRAM - ${label} (cont.)`, LEFT, y - 9, bold, 9, col("#999999"));
    y -= 9 + 12;
  };

  drawText(`${ctx.conference.name} - Revised Agenda`, LEFT, y - 20, bold, 20, col("#111111"));
  y -= 28;
  drawText(ctx.conference.name, LEFT, y - 11, font, 11, col("#444444"));
  y -= 18;
  drawText(label, LEFT, y - 12, bold, 12, col("#111111"));
  y -= 18;
  drawText(`Published ${new Date().toLocaleString()}   -   Version ${version}`, LEFT, y - 9, font, 9, col("#666666"));
  y -= 14;
  page.drawLine({ start: { x: LEFT, y }, end: { x: RIGHT, y }, thickness: 1.5, color: col("#222222") });
  y -= 20;

  drawText("WHAT CHANGED", LEFT, y - 13, bold, 13, col("#111111"));
  y -= 20;
  if (summary) {
    for (const ln of wrap(summary, font, 10, CONTENT_W)) { drawText(ln, LEFT, y - 10, font, 10, col("#333333")); y -= 13; }
    y -= 4;
  }
  if (changes.length) {
    for (const c of changes) {
      const line = `-  "${c.title}" - ${c.oldRange || "TBD"} -> ${c.newRange || "TBD"}, ${c.hall}`;
      for (const ln of wrap(line, font, 10, CONTENT_W)) { drawText(ln, LEFT, y - 10, font, 10, col("#333333")); y -= 13; }
    }
  } else {
    drawText("No individual session changes recorded.", LEFT, y - 10, font, 10, col("#666666")); y -= 13;
  }
  y -= 16;

  drawText(`PROGRAM - ${label}`, LEFT, y - 13, bold, 13, col("#111111"));
  y -= 22;

  const TIME_W = 92;
  const HALL_W = 150;
  const TITLE_X = LEFT + TIME_W;
  const HALL_X = RIGHT - HALL_W;
  const TITLE_W = HALL_X - TITLE_X - 10;

  if (!rows.length) { drawText("No sessions scheduled for this day.", LEFT, y - 10, font, 10, col("#666666")); y -= 13; }
  for (const s of rows) {
    const when = s.start ? `${s.start}-${s.end}` : "";
    let titleLine = s.title;
    if (s.cancelled) titleLine += " (CANCELLED)";
    else if (s.revised) titleLine += " (REVISED)";
    const spk = s.speakers && s.speakers.length ? s.speakers.join(", ") : "";

    const titleLines = wrap(titleLine, bold, 10, TITLE_W);
    const spkLines = spk ? wrap(spk, font, 8, TITLE_W) : [];
    const titleH = titleLines.length * 12;
    const spkH = spkLines.length ? spkLines.length * 10 + 2 : 0;
    const rowH = Math.max(titleH + spkH, 14) + 8;

    if (y - rowH < BOTTOM) newPage();
    const rowTop = y;

    if (s.revised && !s.cancelled) {
      page.drawRectangle({ x: LEFT - 4, y: rowTop - rowH + 3, width: CONTENT_W + 8, height: rowH, color: AMBER });
    }

    drawText(when, LEFT, rowTop - 10, font, 9, col("#0a58ca"));
    let ty = rowTop - 9;
    for (const ln of titleLines) { drawText(ln, TITLE_X, ty, bold, 10, s.cancelled ? col("#c0392b") : col("#111111")); ty -= 12; }
    for (const ln of spkLines) { drawText(ln, TITLE_X, ty, font, 8, col("#777777")); ty -= 10; }
    drawText(s.hall || "", HALL_X, rowTop - 10, font, 8, col("#555555"));

    y = rowTop - rowH;
    page.drawLine({ start: { x: LEFT, y: y + 3 }, end: { x: RIGHT, y: y + 3 }, thickness: 0.5, color: col("#eeeeee") });
  }

  return await doc.save();
}

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
  name: "emit_prose",
  description: "Return the rationale and the per-recipient notification messages.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      rationale: { type: "string" },
      notifications: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, message: { type: "string" } },
          required: ["id", "message"], additionalProperties: false,
        },
      },
    },
    required: ["rationale", "notifications"], additionalProperties: false,
  },
};

async function getAnthropicKey(): Promise<string | null> {
  const { data } = await admin.from("app_settings").select("value").eq("key", "anthropic_api_key").maybeSingle();
  return data?.value ?? null;
}

async function doPublish(req: Request, ctx: Ctx, body: any) {
  const { kind, title, summary, delta = [], notifications = [], actor = "Secretariat" } = body ?? {};
  const cid = ctx.conference.id;

  // PRE-publish feed (for old->new times in the PDF)
  const preFeed = feedSessions(ctx);
  const preById = new Map(preFeed.map((s) => [s.id, s]));

  let dayDate = body?.dayDate;
  if (!dayDate) {
    for (const op of delta) {
      const s = preById.get(op.sessionId);
      if (s?.day) { dayDate = s.day; break; }
    }
  }
  if (!dayDate) dayDate = ctx.days[0]?.date;

  const at = now();
  const version = ctx.revisions.length + 1;

  const { data: revRow, error: revErr } = await admin
    .from("revisions")
    .insert({ conference_id: cid, at, kind, title, summary, delta, actor })
    .select().single();
  if (revErr) return json({ ok: false, error: "revision_failed", detail: revErr.message }, 500);

  // recompute feed with the new revision applied
  ctx.revisions = [...ctx.revisions, revRow];
  const feed = feedSessions(ctx);
  const changed = feed.filter((s) => delta.some((op: any) => op.sessionId === s.id));
  const dayRows = feed.filter((s) => s.day === dayDate);

  const changes = changed.map((s) => {
    const before = preById.get(s.id);
    const oldRange = before && before.start ? `${before.start}-${before.end}` : null;
    const newRange = s.start ? `${s.start}-${s.end}` : null;
    return { id: s.id, title: s.title, oldRange, newRange, hall: s.hall };
  });

  const pdfName = `revised-agenda-v${version}-${dayDate}.pdf`;
  const pdfPath = `${cid}/${pdfName}`;
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await renderAgendaPdf(ctx, { version, dayDate, summary, changes, rows: dayRows });
  } catch (err) {
    return json({ ok: false, error: "pdf_failed", detail: String((err as Error)?.message ?? err) }, 500);
  }
  const up = await admin.storage.from(PDF_BUCKET).upload(pdfPath, pdfBytes, { contentType: "application/pdf", upsert: true });
  if (up.error) return json({ ok: false, error: "pdf_upload_failed", detail: up.error.message }, 500);
  const pdfUrl = pdfPublicUrl(pdfPath);

  const whatsapp = [
    "🔔 *Agenda update - " + ctx.conference.name + "*",
    summary ? "_" + summary + "_" : "",
    ...changed.map((s) => `- "${s.title}" -> now ${s.start ? s.start + "-" + s.end : "TBD"}, ${s.hall}${s.revised ? " (revised)" : ""}`),
    "Live agenda: " + `${fnBase(req)}/c/${ctx.conference.slug}/public/agenda.json`,
  ].filter(Boolean).join("\n");

  const secretariatSig = "\n- " + ctx.conference.name + " Secretariat";

  // (2a) personal emails — one per notification
  const outRows: any[] = [];
  for (const n of notifications) {
    const person = n.personId ? ctx.peopleById.get(n.personId) : null;
    const address = (person && person.emails && person.emails[0]) || null;
    const subject = ctx.conference.name + " - your schedule has changed";
    const body2 = (n.message || "") + "\n\nThe full revised agenda is attached (PDF)." + secretariatSig;
    const mailto = "mailto:" + (address || "") + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body2);
    outRows.push({
      conference_id: cid, at, kind: "personal", to_label: n.to, address, to_count: null, sample: null,
      subject, body: body2, pdf_path: pdfPath, pdf_name: pdfName, mailto,
    });
  }

  // (2b) broadcast email to all faculty + delegates
  const reachable = ctx.people.filter((p) => p.reachable_email);
  const toCount = reachable.length + 1;
  const sample = [...reachable.slice(0, 5).map((p) => p.name), "Delegates mailing list (via registration vendor)"];
  const bSubject = `${ctx.conference.name} - Revised agenda (v${version})`;
  const changeBullets = changed.map((s) => `- "${s.title}" -> ${s.start ? s.start + "-" + s.end : "TBD"}, ${s.hall}`).join("\n");
  const bBody = (summary || "") + "\n\nChanges:\n" + changeBullets + "\n\nThe revised agenda is attached as a PDF." + secretariatSig;
  const bMailto = "mailto:" + "?subject=" + encodeURIComponent(bSubject) + "&body=" + encodeURIComponent(bBody);
  outRows.push({
    conference_id: cid, at, kind: "broadcast", to_label: "All faculty + delegates", address: null,
    to_count: toCount, sample, subject: bSubject, body: bBody, pdf_path: pdfPath, pdf_name: pdfName, mailto: bMailto,
  });
  if (outRows.length) await admin.from("outbox_emails").insert(outRows);

  // (3) whatsapp group post
  await admin.from("whatsapp_posts").insert({
    conference_id: cid, at, grp: ctx.conference.name + " - Faculty & Delegates",
    body: whatsapp, pdf_name: pdfName, pdf_path: pdfPath,
  });

  const feedsBase = `${fnBase(req)}/c/${ctx.conference.slug}`;
  const targets = [
    { name: "Website feed", channel: "website", status: "refreshed", detail: `${feedsBase}/public/agenda.json`, attempts: 1 },
    { name: "ICS calendars", channel: "ics", status: "refreshed", detail: `${feedsBase}/ics/agenda.ics`, attempts: 1 },
    { name: "Revised PDF", channel: "pdf", status: "generated", detail: pdfUrl, attempts: 1 },
    { name: "Email outbox", channel: "email", status: "queued", detail: `${notifications.length} personal + 1 broadcast (${toCount})`, attempts: 1 },
    { name: "Print program", channel: "print", status: "refreshed", detail: `${feedsBase}/print/day/${dayDate}`, attempts: 1 },
    { name: "WhatsApp groups", channel: "whatsapp", status: "posted", detail: "Faculty + Delegates", attempts: 1 },
  ];

  const delivered = notifications.map((n: any) => ({
    ...n, status: n.channel === "phone-call" ? "needs_call" : "sent", attempts: 1,
  }));

  const { data: pubRow } = await admin.from("publications").insert({
    conference_id: cid, revision_id: revRow.id, at, version, title, summary,
    targets, notifications: delivered, whatsapp, pdf_path: pdfPath, pdf_name: pdfName,
  }).select().single();

  return json({
    ok: true,
    publication: {
      id: pubRow?.id, revision_id: revRow.id, at, title, summary,
      targets, notifications: delivered, acked: 0, whatsapp, pdfUrl, pdfName,
    },
    version, last_updated: at,
  });
}

async function chunkedInsert(table: string, rows: any[], size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await admin.from(table).insert(rows.slice(i, i + size));
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function seedWns(body: any) {
  const seed = body?.seed;
  if (!seed || !seed.event) return json({ error: "missing_seed" }, 400);
  const slug = body?.slug || "wns-2026";
  const name = body?.name || seed.event.name;

  const existing = await resolveConf(slug);
  if (existing) return json({ ok: true, existing: true, conference: existing });

  const { data: conf, error: cErr } = await admin.from("conferences").insert({
    slug, name,
    start_date: seed.event.start_date ?? null, end_date: seed.event.end_date ?? null,
    website: seed.event.website ?? null, status: "draft", sample: true,
  }).select().single();
  if (cErr) return json({ error: "conference_failed", detail: cErr.message }, 500);
  const cid = conf.id;

  try {
    await chunkedInsert("days", (seed.days ?? []).map((d: any) => ({ conference_id: cid, date: d.date, label: d.label })));
    await chunkedInsert("halls", (seed.halls ?? []).map((h: any) => ({ conference_id: cid, id: h.id, name: h.name, provisional: !!h.provisional })));
    await chunkedInsert("people", (seed.people ?? []).map((p: any) => ({
      conference_id: cid, id: p.id, name: p.name, name_key: p.name_key ?? null,
      emails: p.emails ?? [], phones: p.phones ?? [], speciality: p.speciality ?? null,
      institution: p.institution ?? null, city: p.city ?? null, country: p.country ?? null,
      segments: p.segments ?? [], declined: !!p.declined, wrong_email: !!p.wrong_email,
      reachable_email: !!p.reachable_email, reachable_wa_sms: !!p.reachable_wa_sms,
    })));
    await chunkedInsert("sessions", (seed.sessions ?? []).map((s: any) => ({
      conference_id: cid, id: s.id, title: s.title, type: s.type ?? null, date: s.date ?? null,
      start_min: s.start_min ?? null, end_min: s.end_min ?? null, track: s.track ?? null,
      stream: s.stream ?? null, state: s.state ?? null, locked: !!s.locked, hall_id: s.hall_id ?? null, band: s.band ?? null,
    })));
    await chunkedInsert("slots", (seed.slots ?? []).map((sl: any) => ({
      conference_id: cid, id: sl.id, session_id: sl.session_id, title: sl.title ?? null,
      duration_min: sl.duration_min ?? null, kind: sl.kind ?? null, ord: sl.order ?? null, // map order -> ord
    })));
    await chunkedInsert("roles", (seed.roles ?? []).map((r: any) => ({
      conference_id: cid, id: r.id, session_id: r.session_id, slot_id: r.slot_id ?? null,
      role_type: r.role_type ?? null, name_raw: r.name_raw ?? null, person_id: r.person_id ?? null, match: r.match ?? null,
    })));
  } catch (err) {
    return json({ error: "seed_insert_failed", detail: String((err as Error)?.message ?? err) }, 500);
  }

  return json({ ok: true, existing: false, conference: conf });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const idx = url.pathname.indexOf("/api");
  let p = idx >= 0 ? url.pathname.slice(idx + 4) : url.pathname;
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+$/, "") || "/";
  const method = req.method;
  const parts = p.split("/").filter(Boolean);

  const readBody = async () => { try { return await req.json(); } catch { return {}; } };

  try {
    if (p === "/conferences" && method === "GET") {
      const { data } = await admin.from("conferences").select("*").order("created_at", { ascending: false });
      return json({ conferences: data ?? [] });
    }
    if (p === "/conferences" && method === "POST") {
      const b = await readBody();
      if (!b.name) return json({ error: "name_required" }, 400);
      const slug = b.slug ? slugify(b.slug) : slugify(b.name);
      const dup = await admin.from("conferences").select("id").eq("slug", slug).maybeSingle();
      if (dup.data) return json({ error: "duplicate_slug", slug }, 409);
      const { data, error } = await admin.from("conferences").insert({
        name: b.name, slug, start_date: b.start_date ?? null, end_date: b.end_date ?? null, website: b.website ?? null,
      }).select().single();
      if (error) return json({ error: "insert_failed", detail: error.message }, 500);
      return json({ conference: data });
    }
    if (p === "/admin/seed-wns" && method === "POST") return await seedWns(await readBody());
    if (p === "/prose/health" && method === "GET") {
      const key = await getAnthropicKey();
      return json({ available: !!key, model: MODEL });
    }
    if (p === "/settings/anthropic-key" && method === "GET") {
      const key = await getAnthropicKey();
      return json({ present: !!key });
    }
    if (p === "/settings/anthropic-key" && method === "POST") {
      const b = await readBody();
      if (!b.key || !String(b.key).startsWith("sk-ant")) return json({ error: "invalid_key" }, 400);
      const { error } = await admin.from("app_settings").upsert({ key: "anthropic_api_key", value: b.key, updated_at: now() }, { onConflict: "key" });
      if (error) return json({ error: "save_failed", detail: error.message }, 500);
      return json({ ok: true });
    }

    if (parts[0] === "c" && parts[1]) {
      const confId = decodeURIComponent(parts[1]);
      const conference = await resolveConf(confId);
      if (!conference) return json({ error: "conference_not_found" }, 404);

      // AI import pipeline (uploads + imports) lives in import.ts. Delegate first;
      // it returns null for any non-import path so existing routes keep working.
      const importRes = await handleImport(req, conference.id, parts, method, readBody);
      if (importRes) return importRes;

      const rest = "/" + parts.slice(2).join("/");

      if (rest === "/agenda" && method === "GET") {
        const ctx = await loadCtx(conference);
        const sessions = ctx.sessions.map((s) => ({ ...s, start: s.start ?? hhmm(s.start_min), end: s.end ?? hhmm(s.end_min) }));
        const slots = ctx.slots.map((sl) => { const { ord, ...rest2 } = sl; return { ...rest2, order: ord }; });
        return json({ conference, days: ctx.days, halls: ctx.halls, people: ctx.people, sessions, slots, roles: ctx.roles });
      }

      if (rest === "/publish" && method === "POST") {
        const ctx = await loadCtx(conference);
        return await doPublish(req, ctx, await readBody());
      }

      if (rest === "/changelog" && method === "GET") {
        const ctx = await loadCtx(conference);
        const { data: pubs } = await admin.from("publications").select("*").eq("conference_id", conference.id).order("at", { ascending: false });
        const lu = await lastUpdated(conference.id, conference.start_date);
        const feedsBase = `${fnBase(req)}/c/${conference.slug}`;
        return json({
          version: ctx.revisions.length + 1, last_updated: lu,
          publications: (pubs ?? []).map((p2: any) => ({
            id: p2.id, at: p2.at, title: p2.title, summary: p2.summary,
            targets: (p2.targets ?? []).map((t: any) => ({ name: t.name, status: t.status, detail: t.detail })),
            notifications: (p2.notifications ?? []).map((n: any) => ({ to: n.to, channel: n.channel, status: n.status })),
            whatsapp: p2.whatsapp, pdfUrl: p2.pdf_path ? pdfPublicUrl(p2.pdf_path) : null, pdfName: p2.pdf_name,
          })),
          feeds: {
            json: `${feedsBase}/public/agenda.json`, ics: `${feedsBase}/ics/agenda.ics`,
            print: ctx.days.map((d) => ({ date: d.date, label: d.label, url: `${feedsBase}/print/day/${d.date}` })),
          },
        });
      }

      if (rest === "/outbox" && method === "GET") {
        const { data } = await admin.from("outbox_emails").select("*").eq("conference_id", conference.id).order("at", { ascending: false });
        const emails = (data ?? []).map((e: any) => ({
          id: e.id, at: e.at, kind: e.kind, to: e.to_label, address: e.address, toCount: e.to_count, sample: e.sample,
          subject: e.subject, body: e.body, pdfName: e.pdf_name, pdfUrl: e.pdf_path ? pdfPublicUrl(e.pdf_path) : null, mailto: e.mailto,
        }));
        return json({ emails });
      }

      if (rest === "/whatsapp" && method === "GET") {
        const { data } = await admin.from("whatsapp_posts").select("*").eq("conference_id", conference.id).order("at", { ascending: false });
        const posts = (data ?? []).map((w: any) => ({ id: w.id, at: w.at, group: w.grp, text: w.body, pdfName: w.pdf_name, pdfUrl: w.pdf_path ? pdfPublicUrl(w.pdf_path) : null }));
        return json({ posts });
      }

      if (rest === "/reports" && method === "GET") {
        const { data } = await admin.from("speaker_reports").select("*").eq("conference_id", conference.id).order("at", { ascending: false });
        const reports = (data ?? []).map((r: any) => ({ id: r.id, personId: r.person_id, kind: r.kind, etaMin: r.eta_min, reason: r.reason, at: r.at, source: r.source, status: r.status }));
        return json({ reports });
      }
      if (rest === "/reports" && method === "POST") {
        const b = await readBody();
        const { data, error } = await admin.from("speaker_reports").insert({
          conference_id: conference.id, person_id: b.personId ?? null, kind: b.kind ?? null,
          eta_min: b.etaMin ?? null, reason: b.reason ?? null, at: now(), source: b.source ?? null, status: "open",
        }).select().single();
        if (error) return json({ error: "report_failed", detail: error.message }, 500);
        return json({ report: { id: data.id, personId: data.person_id, kind: data.kind, etaMin: data.eta_min, reason: data.reason, at: data.at, source: data.source, status: data.status } });
      }
      if (parts[2] === "reports" && parts[3] && method === "POST") {
        const b = await readBody();
        const { error } = await admin.from("speaker_reports").update({ status: b.status }).eq("conference_id", conference.id).eq("id", parts[3]);
        if (error) return json({ error: "update_failed", detail: error.message }, 500);
        return json({ ok: true });
      }

      if (rest === "/state" && method === "GET") {
        const { data } = await admin.from("conference_state").select("flow").eq("conference_id", conference.id).maybeSingle();
        return json({ flow: data?.flow ?? null });
      }
      if (rest === "/state" && method === "POST") {
        const b = await readBody();
        const { error } = await admin.from("conference_state").upsert({ conference_id: conference.id, flow: b.flow ?? null, updated_at: now() }, { onConflict: "conference_id" });
        if (error) return json({ error: "state_failed", detail: error.message }, 500);
        return json({ ok: true });
      }

      if (rest === "/prose" && method === "POST") {
        const key = await getAnthropicKey();
        if (!key) return json({ error: "no_api_key" }, 503);
        const b = await readBody();
        try {
          const client = new Anthropic({ apiKey: key });
          const message = await client.messages.create({
            model: MODEL, max_tokens: 1024, system: SYSTEM, tools: [PROSE_TOOL as any],
            tool_choice: { type: "tool", name: "emit_prose" },
            messages: [{ role: "user", content: "Write the copy for this validated change:\n\n" + JSON.stringify(b ?? {}, null, 2) }],
          });
          const block = message.content.find((x: any) => x.type === "tool_use") as any;
          if (!block) return json({ error: "no_tool_use" }, 502);
          return json(block.input);
        } catch (err: any) {
          const status = err?.status && err.status >= 400 && err.status < 600 ? 502 : 500;
          return json({ error: "claude_error", detail: String(err?.message ?? err) }, status);
        }
      }

      if (rest === "/public/agenda.json" && method === "GET") {
        const ctx = await loadCtx(conference);
        const lu = await lastUpdated(conference.id, conference.start_date);
        return json({
          event: { id: conference.slug, name: conference.name, start_date: conference.start_date, end_date: conference.end_date, website: conference.website },
          generated: now(), last_updated: lu, days: ctx.days, halls: ctx.halls.map((h) => h.name),
          sessions: feedSessions(ctx).map(({ _revs, start_min, end_min, ...pub }) => { void _revs; void start_min; void end_min; return pub; }),
        });
      }

      if (rest === "/ics/agenda.ics" && method === "GET") {
        const ctx = await loadCtx(conference);
        return textResp(buildIcs(ctx, null), "text/calendar; charset=utf-8");
      }
      if (parts[2] === "ics" && parts[3] === "person" && parts[4] && method === "GET") {
        const ctx = await loadCtx(conference);
        const personId = decodeURIComponent(parts[4]).replace(/\.ics$/, "");
        return textResp(buildIcs(ctx, personId), "text/calendar; charset=utf-8");
      }

      if (parts[2] === "print" && parts[3] === "day" && parts[4] && method === "GET") {
        const ctx = await loadCtx(conference);
        const date = decodeURIComponent(parts[4]);
        return textResp(printDayHtml(ctx, date), "text/html; charset=utf-8");
      }

      if (rest === "/reset" && method === "POST") {
        const cid = conference.id;
        for (const t of ["publications", "revisions", "outbox_emails", "whatsapp_posts", "speaker_reports"]) {
          await admin.from(t).delete().eq("conference_id", cid);
        }
        await admin.from("conference_state").delete().eq("conference_id", cid);
        return json({ ok: true });
      }
    }

    return json({ error: "not_found", path: p }, 404);
  } catch (err) {
    return json({ error: "server_error", detail: String((err as Error)?.message ?? err) }, 500);
  }
});
