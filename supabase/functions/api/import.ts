// AgendaPilot — AI import pipeline (Phase B).
// Organizers upload conference program files (xlsx/docx/pdf/csv); Claude parses
// them into a normalized schedule draft (import_drafts); a human reviews; then commits.
//
// This module owns the upload + import endpoints. index.ts delegates to handleImport().
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";
import * as XLSX from "npm:xlsx";
import JSZip from "npm:jszip";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = "claude-opus-4-8";
const UPLOAD_BUCKET = "ap-uploads";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const now = () => new Date().toISOString();
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function getAnthropicKey(): Promise<string | null> {
  const { data } = await admin.from("app_settings").select("value").eq("key", "anthropic_api_key").maybeSingle();
  return data?.value ?? null;
}

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------
function sanitizeFilename(name: string) {
  return String(name || "file")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "file";
}
function slug(name: string) {
  return String(name || "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
// name_key: UPPERCASE, strip academic titles + punctuation, collapse spaces.
function nameKey(name: string) {
  let s = String(name || "").trim();
  // strip leading titles (possibly repeated), e.g. "Dr. Prof. K. Radhakrishnan"
  s = s.replace(/^((dr|prof|professor|mr|mrs|ms|col|col\.|brig|maj|gen|lt|capt|surg|air marshal|padma shri|padmashri)\.?\s+)+/i, "");
  // strip trailing designations rarely present; keep it simple
  s = s.replace(/\bdr\.?\b/gi, " ").replace(/\bprof\.?\b/gi, " ");
  s = s.replace(/[^A-Za-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  return s.toUpperCase();
}
const noSpace = (s: string) => s.replace(/\s+/g, "");
function hhmmToMin(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// ---------------------------------------------------------------------------
// content extraction
// ---------------------------------------------------------------------------
function extForName(name: string, mime: string): string {
  const lower = (name || "").toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return "xlsx";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".txt")) return "txt";
  if (lower.endsWith(".pdf")) return "pdf";
  const m = mime || "";
  if (m.includes("spreadsheet") || m.includes("excel")) return "xlsx";
  if (m.includes("word") || m.includes("officedocument.wordprocessing")) return "docx";
  if (m.includes("pdf")) return "pdf";
  if (m.includes("csv")) return "csv";
  if (m.startsWith("text/")) return "txt";
  return "txt";
}

function extractXlsx(bytes: Uint8Array): string {
  const wb = XLSX.read(bytes, { type: "array" });
  const out: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
    out.push(`### SHEET: ${sheetName}`);
    rows.forEach((row, i) => {
      const cells = (row || []).map((c) => (c == null ? "" : String(c).replace(/\s+/g, " ").trim()));
      // drop fully-empty rows
      if (cells.every((c) => c === "")) return;
      out.push(`R${i}: ${cells.join(" | ")}`);
    });
    out.push("");
  }
  return out.join("\n");
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file("word/document.xml");
  if (!file) return "";
  let xml = await file.async("string");
  // paragraph + line breaks -> newlines
  xml = xml.replace(/<\/w:p>/g, "\n").replace(/<w:br\s*\/?>/g, "\n").replace(/<w:tab\s*\/?>/g, "\t");
  // strip all remaining tags
  let text = xml.replace(/<[^>]+>/g, "");
  // decode common XML entities
  text = text
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  // collapse runs of blank lines, trim each line
  const lines = text.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter((l) => l !== "");
  return lines.join("\n");
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// chunking
// ---------------------------------------------------------------------------
// Split text into <= maxChars chunks, preferring to break on blank lines /
// day-header / sheet / section boundaries. Never split mid-line.
function chunkText(text: string, maxChars = 12000): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  const boundaryRe = /^(###\s|SHEET|DAY[\s-]|.*\b(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)\b.*\d{4}|Session\s+[A-Z]\b)/i;
  const flush = () => { if (cur.length) { chunks.push(cur.join("\n")); cur = []; curLen = 0; } };
  for (const line of lines) {
    const addLen = line.length + 1;
    // If adding overflows and we have content, try to break here (on a boundary if possible).
    if (curLen + addLen > maxChars && cur.length) {
      flush();
    }
    cur.push(line);
    curLen += addLen;
    // proactive break on a strong boundary once we're past ~60% so chunks align to days/sections
    if (curLen > maxChars * 0.6 && boundaryRe.test(line) && cur.length > 3) {
      // keep the boundary line as the start of the NEXT chunk
      const boundaryLine = cur.pop()!;
      flush();
      cur.push(boundaryLine);
      curLen = boundaryLine.length + 1;
    }
  }
  flush();
  return chunks.length ? chunks : [text];
}

// Chunk CONTACTS text by ~rowsPerChunk data rows (lines starting with "R<n>:" or non-empty rows).
function chunkContacts(text: string, rowsPerChunk = 150): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let cur: string[] = [];
  let dataRows = 0;
  // preserve sheet headers across chunks
  let header = "";
  for (const line of lines) {
    if (/^###\s|^SHEET/i.test(line)) { header = line; }
    cur.push(line);
    if (/^R\d+:/.test(line)) dataRows++;
    if (dataRows >= rowsPerChunk) {
      chunks.push(cur.join("\n"));
      cur = header ? [header] : [];
      dataRows = 0;
    }
  }
  if (cur.length) chunks.push(cur.join("\n"));
  return chunks.length ? chunks : [text];
}

// ---------------------------------------------------------------------------
// Claude prompts + tools
// ---------------------------------------------------------------------------
const CLASSIFY_TOOL = {
  name: "emit_classification",
  description: "Classify what kind of conference document this is.",
  input_schema: {
    type: "object" as const,
    properties: {
      kind: { type: "string", enum: ["program", "contacts", "both", "other"] },
      notes: { type: "string" },
    },
    required: ["kind", "notes"],
    additionalProperties: false,
  },
};

const PROGRAM_TOOL = {
  name: "emit_program",
  description: "Return the parsed conference program (days, halls, sessions).",
  input_schema: {
    type: "object" as const,
    properties: {
      days: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: { type: ["string", "null"], description: "YYYY-MM-DD or null" },
            label: { type: "string" },
          },
          required: ["date", "label"],
          additionalProperties: false,
        },
      },
      halls: { type: "array", items: { type: "string" } },
      sessions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            date: { type: ["string", "null"], description: "YYYY-MM-DD or null" },
            start: { type: ["string", "null"], description: "HH:MM 24h or null" },
            end: { type: ["string", "null"], description: "HH:MM 24h or null" },
            hall: { type: ["string", "null"] },
            track: { type: ["string", "null"] },
            kind: { type: "string", enum: ["session", "break"] },
            slots: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  duration_min: { type: ["integer", "null"] },
                  speakers: { type: "array", items: { type: "string" } },
                },
                required: ["title", "duration_min", "speakers"],
                additionalProperties: false,
              },
            },
            moderators: { type: "array", items: { type: "string" } },
            panelists: { type: "array", items: { type: "string" } },
            experts: { type: "array", items: { type: "string" } },
          },
          required: ["title", "date", "start", "end", "hall", "track", "kind", "slots", "moderators", "panelists", "experts"],
          additionalProperties: false,
        },
      },
    },
    required: ["days", "halls", "sessions"],
    additionalProperties: false,
  },
};

const CONTACTS_TOOL = {
  name: "emit_contacts",
  description: "Return the parsed contact/faculty list.",
  input_schema: {
    type: "object" as const,
    properties: {
      people: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            emails: { type: "array", items: { type: "string" } },
            phones: { type: "array", items: { type: "string" } },
            speciality: { type: ["string", "null"] },
            institution: { type: ["string", "null"] },
            city: { type: ["string", "null"] },
            country: { type: ["string", "null"] },
          },
          required: ["name", "emails", "phones", "speciality", "institution", "city", "country"],
          additionalProperties: false,
        },
      },
    },
    required: ["people"],
    additionalProperties: false,
  },
};

const PARSE_SYSTEM = `You are AgendaPilot's document parser for a large medical conference.
You convert raw conference documents into a normalized structured schedule.

Absolute rules:
- Extract ONLY what is literally present in the document. NEVER invent times, halls, names, dates, speakers, or topics. If something is not stated, leave it null / empty.
- Derive each session's date from the nearest preceding day header (e.g. "THURSDAY, 20 AUGUST 2026" -> date "2026-08-20"; "DAY-1, FRIDAY, 21-AUGUST 2026" -> "2026-08-21"). If no year/date is derivable, set date to null but keep a descriptive day label.
- Times must be 24-hour "HH:MM". Convert ranges like "09:10 - 09:50 Hrs" into start "09:10" and end "09:50". "02:30 PM" -> "14:30". If only a start ("09:30 AM Onwards") is given, set start and leave end null.
- Breaks (TEA BREAK, LUNCH, BREAKFAST as a standalone row, coffee) have kind "break". Everything else is kind "session".
- Role lines like "Moderator: X", "Session Expert: Y", "Grand Master: Z", "Session Experts: A, B", "Panelists: ..." attach to the CURRENT session. Put moderators in moderators[], session experts / grand masters in experts[], panelists in panelists[]. Split multiple names on "/" , "&" and ",".
- A row with a time + a title + a single speaker is a talk. When talks are nested inside a workshop/session that spans a time range, put each talk as a slot of that workshop (slots[].title + speakers). Strip trailing durations like "(15 Min)" from the title and put the integer minutes into duration_min.
- For untimed topic-list programs (Session A/B/C headings with bare topic lines and no times), emit one session per "Session X:" heading with its topics as slots (duration_min null, speakers empty unless a name is given), date from the day header, start/end null.
- "All Faculty" as a speaker is allowed as a literal name; keep it.
- Do not duplicate day headers as sessions.

Call the requested tool exactly once with everything you found in THIS chunk.`;

const CONTACTS_SYSTEM = `You are AgendaPilot's contact-sheet parser for a medical conference.
Extract the faculty/contact rows into structured people.

Absolute rules:
- Extract ONLY rows that are actual people. Skip header rows, section titles, totals, and blank rows.
- name: the person's full name as written (you may keep the title e.g. "Dr").
- emails: every email present for that person (may be split across columns); lowercase, trimmed. Empty array if none.
- phones: every phone/mobile number present, kept as written (keep leading +country code if shown). Empty array if none.
- speciality / institution / city / country: copy from the matching columns if present, else null.
- NEVER invent an email or phone. If a cell is blank, omit it.
Call emit_contacts exactly once with all people in THIS chunk.`;

async function classify(client: Anthropic, opts: { text?: string; pdf?: string }): Promise<{ kind: string; notes: string }> {
  const content: any[] = [];
  if (opts.pdf) {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: opts.pdf } });
    content.push({ type: "text", text: "Classify this conference document." });
  } else {
    content.push({ type: "text", text: "Classify this conference document. First lines:\n\n" + (opts.text || "").slice(0, 3000) });
  }
  const msg = await client.messages.create({
    model: MODEL, max_tokens: 200,
    tools: [CLASSIFY_TOOL as any], tool_choice: { type: "tool", name: "emit_classification" },
    messages: [{ role: "user", content }],
  });
  const block = msg.content.find((x: any) => x.type === "tool_use") as any;
  return block?.input ?? { kind: "other", notes: "no classification" };
}

async function callTool(client: Anthropic, system: string, toolDef: any, toolName: string, userContent: any[]): Promise<any> {
  const stream = client.messages.stream({
    model: MODEL, max_tokens: 16000, system,
    tools: [toolDef], tool_choice: { type: "tool", name: toolName },
    messages: [{ role: "user", content: userContent }],
  });
  const msg = await stream.finalMessage();
  const block = msg.content.find((x: any) => x.type === "tool_use") as any;
  return block?.input ?? null;
}

// ---------------------------------------------------------------------------
// normalization + merge into draft
// ---------------------------------------------------------------------------
type DraftData = {
  days: { date: string | null; label: string }[];
  halls: { id: string; name: string }[];
  people: any[];
  sessions: any[];
  slots: any[];
  roles: any[];
  // counters for stable id generation across merges
  _counters: { s: number; sl: number; r: number };
  _files: string[];
};

function emptyDraft(): DraftData {
  return { days: [], halls: [], people: [], sessions: [], slots: [], roles: [], _counters: { s: 0, sl: 0, r: 0 }, _files: [] };
}

// find/merge a person into the draft by name_key; returns the person id.
function upsertPerson(draft: DraftData, byKey: Map<string, any>, raw: {
  name: string; emails?: string[]; phones?: string[]; speciality?: string | null;
  institution?: string | null; city?: string | null; country?: string | null;
}): string {
  const key = nameKey(raw.name);
  const keyNs = noSpace(key);
  let person = byKey.get(key) || byKey.get("NS:" + keyNs);
  const emails = (raw.emails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  const phones = (raw.phones || []).map((p) => String(p).trim()).filter(Boolean);
  if (person) {
    for (const e of emails) if (!person.emails.includes(e)) person.emails.push(e);
    for (const p of phones) if (!person.phones.includes(p)) person.phones.push(p);
    person.speciality = person.speciality || raw.speciality || null;
    person.institution = person.institution || raw.institution || null;
    person.city = person.city || raw.city || null;
    person.country = person.country || raw.country || null;
    person.reachable_email = person.emails.length > 0;
    person.reachable_wa_sms = person.phones.length > 0;
    return person.id;
  }
  const id = "p-" + (slug(raw.name) || ("x" + (draft.people.length + 1)));
  person = {
    id, name: raw.name.trim(), name_key: key,
    emails, phones,
    speciality: raw.speciality || null, institution: raw.institution || null,
    city: raw.city || null, country: raw.country || null,
    segments: [], declined: false, wrong_email: false,
    reachable_email: emails.length > 0, reachable_wa_sms: phones.length > 0,
  };
  // avoid id collision (two different people slugging equal) — suffix
  if (draft.people.some((pp) => pp.id === id)) {
    person.id = id + "-" + (draft.people.length + 1);
  }
  draft.people.push(person);
  byKey.set(key, person);
  byKey.set("NS:" + keyNs, person);
  return person.id;
}

// resolve a role name against draft + existing conference people (by name_key)
function resolveName(name: string, byKey: Map<string, any>): { person_id: string | null; match: string } {
  const trimmed = String(name || "").trim();
  if (!trimmed) return { person_id: null, match: "unmatched" };
  if (/^all\s+faculty$/i.test(trimmed) || /^faculty$/i.test(trimmed)) return { person_id: null, match: "group" };
  const key = nameKey(trimmed);
  const exact = byKey.get(key);
  if (exact) return { person_id: exact.id, match: "exact" };
  const ns = byKey.get("NS:" + noSpace(key));
  if (ns) return { person_id: ns.id, match: "exact" };
  return { person_id: null, match: "unmatched" };
}

function roleType(kind: "speaker" | "moderator" | "panellist" | "session_expert") { return kind; }

// Merge a parsed program payload into the draft.
function mergeProgram(draft: DraftData, byKey: Map<string, any>, prog: any) {
  // days
  for (const d of (prog.days || [])) {
    const label = String(d.label || "").trim();
    const date = d.date || null;
    if (!label && !date) continue;
    const dup = draft.days.find((x) => (date && x.date === date) || (!date && x.label === label));
    if (!dup) draft.days.push({ date, label: label || (date ?? "Day") });
  }
  // halls
  for (const h of (prog.halls || [])) {
    const name = String(h || "").trim();
    if (!name) continue;
    const id = slug(name) || ("hall-" + (draft.halls.length + 1));
    if (!draft.halls.some((x) => x.id === id)) draft.halls.push({ id, name });
  }
  // sessions
  for (const s of (prog.sessions || [])) {
    const title = String(s.title || "").trim();
    if (!title) continue;
    const sid = `imp-s${++draft._counters.s}`;
    const startMin = hhmmToMin(s.start);
    const endMin = hhmmToMin(s.end);
    const isBreak = s.kind === "break";
    const hallId = s.hall ? (slug(String(s.hall)) || null) : null;
    // ensure hall exists in draft.halls
    if (hallId && !draft.halls.some((x) => x.id === hallId)) {
      draft.halls.push({ id: hallId, name: String(s.hall).trim() });
    }
    draft.sessions.push({
      id: sid, title,
      type: isBreak ? "break" : "session",
      date: s.date || null,
      start_min: startMin, end_min: endMin,
      track: s.track || "", stream: "main",
      state: startMin == null ? "DRAFT" : "SCHEDULED",
      locked: false, hall_id: hallId, band: null,
    });
    // slots
    let ord = 0;
    for (const sl of (s.slots || [])) {
      const stitle = String(sl.title || "").trim();
      if (!stitle) continue;
      const slid = `imp-sl${++draft._counters.sl}`;
      draft.slots.push({
        id: slid, session_id: sid, title: stitle,
        duration_min: sl.duration_min ?? null, kind: "talk", ord: ord++,
      });
      // slot speakers -> speaker roles (attached to slot)
      for (const spk of (sl.speakers || [])) {
        const nm = String(spk || "").trim();
        if (!nm) continue;
        const res = resolveName(nm, byKey);
        draft.roles.push({
          id: `imp-r${++draft._counters.r}`, session_id: sid, slot_id: slid,
          role_type: roleType("speaker"), name_raw: nm, person_id: res.person_id, match: res.match,
        });
      }
    }
    // session-level roles
    const addRoles = (arr: any[], rt: "moderator" | "panellist" | "session_expert") => {
      for (const nm0 of (arr || [])) {
        const nm = String(nm0 || "").trim();
        if (!nm) continue;
        const res = resolveName(nm, byKey);
        draft.roles.push({
          id: `imp-r${++draft._counters.r}`, session_id: sid, slot_id: null,
          role_type: rt, name_raw: nm, person_id: res.person_id, match: res.match,
        });
      }
    };
    addRoles(s.moderators, "moderator");
    addRoles(s.panelists, "panellist");
    addRoles(s.experts, "session_expert");
  }
}

function mergeContacts(draft: DraftData, byKey: Map<string, any>, con: any) {
  for (const p of (con.people || [])) {
    const name = String(p.name || "").trim();
    if (!name) continue;
    upsertPerson(draft, byKey, p);
  }
}

// After a merge, roles created before their person existed may now resolve.
// Re-run resolution for any unmatched role.
function reResolveRoles(draft: DraftData, byKey: Map<string, any>) {
  for (const r of draft.roles) {
    if (r.match === "exact" || r.match === "group") continue;
    const res = resolveName(r.name_raw, byKey);
    if (res.match !== "unmatched") { r.person_id = res.person_id; r.match = res.match; }
  }
}

function computeSummary(draft: DraftData): any {
  const resolvedRoles = draft.roles.filter((r) => r.match === "exact").length;
  const groupRoles = draft.roles.filter((r) => r.match === "group").length;
  const unresolvedRoles = draft.roles.filter((r) => r.match === "unmatched").length;
  const noTime = draft.sessions.filter((s) => s.type !== "break" && s.start_min == null).length;
  const flags: string[] = [];
  if (noTime > 0) flags.push(`${noTime} session${noTime === 1 ? "" : "s"} have no time yet`);
  if (unresolvedRoles > 0) flags.push(`${unresolvedRoles} speaker/role name${unresolvedRoles === 1 ? "" : "s"} not found in the contact list`);
  if (draft.people.length === 0) flags.push("no contact list imported yet — speakers cannot be matched to emails/phones");
  const daysNoDate = draft.days.filter((d) => !d.date).length;
  if (daysNoDate > 0) flags.push(`${daysNoDate} day${daysNoDate === 1 ? "" : "s"} could not be dated`);
  return {
    files: draft._files.slice(),
    days: draft.days.length, halls: draft.halls.length, sessions: draft.sessions.length,
    slots: draft.slots.length, people: draft.people.length,
    resolvedRoles: resolvedRoles + groupRoles, unresolvedRoles, flags,
  };
}

// build the name_key map from draft people + existing conference people
async function buildNameKeyMap(confId: string, draft: DraftData): Promise<Map<string, any>> {
  const byKey = new Map<string, any>();
  for (const p of draft.people) {
    byKey.set(p.name_key, p);
    byKey.set("NS:" + noSpace(p.name_key), p);
  }
  // existing conference people (already committed) — for resolution only.
  const { data: existing } = await admin.from("people").select("id,name,name_key,emails,phones").eq("conference_id", confId);
  for (const p of (existing || [])) {
    const key = p.name_key || nameKey(p.name);
    if (!byKey.has(key)) byKey.set(key, { id: p.id, name: p.name, name_key: key, emails: p.emails ?? [], phones: p.phones ?? [], _existing: true });
    const nsk = "NS:" + noSpace(key);
    if (!byKey.has(nsk)) byKey.set(nsk, byKey.get(key));
  }
  return byKey;
}

// ---------------------------------------------------------------------------
// draft persistence
// ---------------------------------------------------------------------------
async function getActiveDraft(confId: string): Promise<any | null> {
  const { data } = await admin.from("import_drafts").select("*")
    .eq("conference_id", confId).eq("status", "draft")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data ?? null;
}

function loadDraftData(row: any): DraftData {
  const d = row?.data && typeof row.data === "object" ? row.data : {};
  const base = emptyDraft();
  return {
    days: d.days ?? base.days,
    halls: d.halls ?? base.halls,
    people: d.people ?? base.people,
    sessions: d.sessions ?? base.sessions,
    slots: d.slots ?? base.slots,
    roles: d.roles ?? base.roles,
    _counters: d._counters ?? base._counters,
    _files: d._files ?? base._files,
  };
}

// ---------------------------------------------------------------------------
// the process pipeline
// ---------------------------------------------------------------------------
async function processUpload(confId: string, uploadId: string): Promise<Response> {
  const key = await getAnthropicKey();
  if (!key) return json({ error: "no_api_key" }, 503);

  const { data: upload } = await admin.from("uploads").select("*").eq("id", uploadId).eq("conference_id", confId).maybeSingle();
  if (!upload) return json({ error: "upload_not_found" }, 404);

  // download the file
  const dl = await admin.storage.from(UPLOAD_BUCKET).download(upload.storage_path);
  if (dl.error || !dl.data) return json({ error: "download_failed", detail: dl.error?.message ?? "no data" }, 404);
  const bytes = new Uint8Array(await dl.data.arrayBuffer());
  const ext = extForName(upload.filename, upload.mime);

  // extract content
  let text = "";
  let pdfB64: string | null = null;
  try {
    if (ext === "xlsx") text = extractXlsx(bytes);
    else if (ext === "docx") text = await extractDocx(bytes);
    else if (ext === "pdf") pdfB64 = bytesToBase64(bytes);
    else text = new TextDecoder().decode(bytes); // csv / txt
  } catch (err) {
    return json({ error: "extract_failed", detail: String((err as Error)?.message ?? err) }, 502);
  }

  const client = new Anthropic({ apiKey: key });

  // load / create active draft
  let draftRow = await getActiveDraft(confId);
  if (!draftRow) {
    const { data, error } = await admin.from("import_drafts")
      .insert({ conference_id: confId, status: "draft", summary: {}, data: emptyDraft() })
      .select().single();
    if (error) return json({ error: "draft_create_failed", detail: error.message }, 500);
    draftRow = data;
  }
  const draft = loadDraftData(draftRow);

  try {
    // (a) classify
    const cls = await classify(client, pdfB64 ? { pdf: pdfB64 } : { text });
    const kind = cls.kind;

    const byKey = await buildNameKeyMap(confId, draft);

    // (b) parse with chunking
    if (pdfB64) {
      // PDF: send whole, one call each for whatever it contains.
      if (kind === "program" || kind === "both" || kind === "other") {
        const prog = await callTool(client, PARSE_SYSTEM, PROGRAM_TOOL, "emit_program", [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 } },
          { type: "text", text: "Parse the program from this PDF." },
        ]);
        if (prog) mergeProgram(draft, byKey, prog);
      }
      if (kind === "contacts" || kind === "both") {
        const con = await callTool(client, CONTACTS_SYSTEM, CONTACTS_TOOL, "emit_contacts", [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 } },
          { type: "text", text: "Parse the contact list from this PDF." },
        ]);
        if (con) mergeContacts(draft, byKey, con);
      }
    } else {
      if (kind === "contacts") {
        // contacts first so people exist before any (rare) role resolution
        for (const ch of chunkContacts(text, 150)) {
          const con = await callTool(client, CONTACTS_SYSTEM, CONTACTS_TOOL, "emit_contacts", [{ type: "text", text: ch }]);
          if (con) mergeContacts(draft, byKey, con);
        }
      } else if (kind === "both") {
        // process contacts portion first (best-effort: same text), then program
        for (const ch of chunkContacts(text, 150)) {
          const con = await callTool(client, CONTACTS_SYSTEM, CONTACTS_TOOL, "emit_contacts", [{ type: "text", text: ch }]);
          if (con) mergeContacts(draft, byKey, con);
        }
        for (const ch of chunkText(text, 12000)) {
          const prog = await callTool(client, PARSE_SYSTEM, PROGRAM_TOOL, "emit_program", [{ type: "text", text: ch }]);
          if (prog) mergeProgram(draft, byKey, prog);
        }
      } else {
        // program or other -> treat as program
        for (const ch of chunkText(text, 12000)) {
          const prog = await callTool(client, PARSE_SYSTEM, PROGRAM_TOOL, "emit_program", [{ type: "text", text: ch }]);
          if (prog) mergeProgram(draft, byKey, prog);
        }
      }
    }

    // resolve any roles that now match newly-added people
    reResolveRoles(draft, byKey);
  } catch (err: any) {
    return json({ error: "parse_failed", detail: String(err?.message ?? err) }, 502);
  }

  // record processed file
  if (!draft._files.includes(upload.filename)) draft._files.push(upload.filename);

  const summary = computeSummary(draft);
  const { error: upErr } = await admin.from("import_drafts")
    .update({ data: draft, summary, updated_at: now() })
    .eq("id", draftRow.id);
  if (upErr) return json({ error: "draft_save_failed", detail: upErr.message }, 500);

  // mark upload processed
  await admin.from("uploads").update({ status: "processed" }).eq("id", uploadId);

  return json({ ok: true, draftId: draftRow.id, summary });
}

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------
async function commitDraft(confId: string, mode: "replace" | "append"): Promise<Response> {
  const draftRow = await getActiveDraft(confId);
  if (!draftRow) return json({ error: "no_active_draft" }, 404);
  const draft = loadDraftData(draftRow);

  if (mode === "replace") {
    // clean slate: schedule + activity data (keep conference + app_settings + uploads/import_drafts)
    for (const t of ["roles", "slots", "sessions", "halls", "days", "people",
      "publications", "revisions", "outbox_emails", "whatsapp_posts", "speaker_reports"]) {
      await admin.from(t).delete().eq("conference_id", confId);
    }
    await admin.from("conference_state").delete().eq("conference_id", confId);
  }

  // append-mode collision avoidance: existing ids get their draft counterpart suffixed "-b"
  const idMap = new Map<string, string>(); // old session id -> new session id
  const slotIdMap = new Map<string, string>();
  let existingSessionIds = new Set<string>();
  let existingSlotIds = new Set<string>();
  let existingRoleIds = new Set<string>();
  if (mode === "append") {
    const [sx, slx, rx] = await Promise.all([
      admin.from("sessions").select("id").eq("conference_id", confId),
      admin.from("slots").select("id").eq("conference_id", confId),
      admin.from("roles").select("id").eq("conference_id", confId),
    ]);
    existingSessionIds = new Set((sx.data ?? []).map((r: any) => r.id));
    existingSlotIds = new Set((slx.data ?? []).map((r: any) => r.id));
    existingRoleIds = new Set((rx.data ?? []).map((r: any) => r.id));
  }
  const newSessionId = (id: string) => {
    let nid = id;
    if (existingSessionIds.has(nid)) nid = id + "-b";
    idMap.set(id, nid);
    return nid;
  };
  const newSlotId = (id: string) => {
    let nid = id;
    if (existingSlotIds.has(nid)) nid = id + "-b";
    slotIdMap.set(id, nid);
    return nid;
  };

  // days
  const dayRows = draft.days
    .filter((d) => d.date)
    .map((d) => ({ conference_id: confId, date: d.date, label: d.label }));
  // halls
  const hallRows = draft.halls.map((h) => ({ conference_id: confId, id: h.id, name: h.name, provisional: true }));
  // sessions
  const sessionRows = draft.sessions.map((s) => ({
    conference_id: confId, id: mode === "append" ? newSessionId(s.id) : s.id,
    title: s.title, type: s.type, date: s.date, start_min: s.start_min, end_min: s.end_min,
    track: s.track ?? "", stream: s.stream ?? "main", state: s.state, locked: !!s.locked,
    hall_id: s.hall_id ?? null, band: s.band ?? null,
  }));
  // slots
  const slotRows = draft.slots.map((sl) => ({
    conference_id: confId, id: mode === "append" ? newSlotId(sl.id) : sl.id,
    session_id: mode === "append" ? (idMap.get(sl.session_id) ?? sl.session_id) : sl.session_id,
    title: sl.title, duration_min: sl.duration_min ?? null, kind: sl.kind ?? "talk", ord: sl.ord ?? 0,
  }));
  // roles
  const roleRows = draft.roles.map((r) => {
    const rid = mode === "append" && existingRoleIds.has(r.id) ? r.id + "-b" : r.id;
    return {
      conference_id: confId, id: rid,
      session_id: mode === "append" ? (idMap.get(r.session_id) ?? r.session_id) : r.session_id,
      slot_id: r.slot_id ? (mode === "append" ? (slotIdMap.get(r.slot_id) ?? r.slot_id) : r.slot_id) : null,
      role_type: r.role_type, name_raw: r.name_raw,
      person_id: r.person_id ?? null, match: r.match ?? "unmatched",
    };
  });

  const counts = { sessions: sessionRows.length, slots: slotRows.length, roles: roleRows.length, people: draft.people.length };

  try {
    // days: upsert to avoid PK clashes on (conference_id,date)
    if (dayRows.length) {
      const { error } = await admin.from("days").upsert(dayRows, { onConflict: "conference_id,date" });
      if (error) throw new Error("days: " + error.message);
    }
    if (hallRows.length) {
      const { error } = await admin.from("halls").upsert(hallRows, { onConflict: "conference_id,id" });
      if (error) throw new Error("halls: " + error.message);
    }
    // people: upsert on (conference_id,id), merging emails/phones with existing
    if (draft.people.length) {
      const { data: existingPeople } = await admin.from("people").select("id,emails,phones").eq("conference_id", confId);
      const exMap = new Map((existingPeople ?? []).map((p: any) => [p.id, p]));
      const peopleRows = draft.people.map((p) => {
        const ex = exMap.get(p.id);
        let emails = p.emails ?? [];
        let phones = p.phones ?? [];
        if (ex) {
          emails = Array.from(new Set([...(ex.emails ?? []), ...emails]));
          phones = Array.from(new Set([...(ex.phones ?? []), ...phones]));
        }
        return {
          conference_id: confId, id: p.id, name: p.name, name_key: p.name_key ?? nameKey(p.name),
          emails, phones, speciality: p.speciality ?? null, institution: p.institution ?? null,
          city: p.city ?? null, country: p.country ?? null, segments: p.segments ?? [],
          declined: false, wrong_email: false,
          reachable_email: emails.length > 0, reachable_wa_sms: phones.length > 0,
        };
      });
      for (let i = 0; i < peopleRows.length; i += 500) {
        const { error } = await admin.from("people").upsert(peopleRows.slice(i, i + 500), { onConflict: "conference_id,id" });
        if (error) throw new Error("people: " + error.message);
      }
    }
    const insertChunked = async (table: string, rows: any[]) => {
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await admin.from(table).insert(rows.slice(i, i + 500));
        if (error) throw new Error(table + ": " + error.message);
      }
    };
    if (sessionRows.length) await insertChunked("sessions", sessionRows);
    if (slotRows.length) await insertChunked("slots", slotRows);
    if (roleRows.length) await insertChunked("roles", roleRows);
  } catch (err: any) {
    return json({ error: "commit_failed", detail: String(err?.message ?? err) }, 500);
  }

  // mark draft committed
  await admin.from("import_drafts").update({ status: "committed", updated_at: now() }).eq("id", draftRow.id);

  // set conference live if it has timed sessions
  const hasTimed = draft.sessions.some((s) => s.start_min != null);
  if (hasTimed) await admin.from("conferences").update({ status: "live" }).eq("id", confId);

  return json({ ok: true, counts });
}

// ---------------------------------------------------------------------------
// router — returns null if the path is not an import route (index.ts continues)
// ---------------------------------------------------------------------------
export async function handleImport(
  req: Request, confId: string, parts: string[], method: string, readBody: () => Promise<any>,
): Promise<Response | null> {
  // parts = ["c", "<confId>", ...rest]
  const rest = parts.slice(2); // after /c/:confId

  // ---- uploads ----
  if (rest[0] === "uploads" && rest.length === 1 && method === "GET") {
    const { data } = await admin.from("uploads").select("*").eq("conference_id", confId).order("created_at", { ascending: false });
    return json({ uploads: data ?? [] });
  }

  if (rest[0] === "uploads" && rest[1] === "sign" && rest.length === 2 && method === "POST") {
    const b = await readBody();
    const filename = String(b?.filename || "file");
    const mime = b?.mime ?? null;
    const size = b?.size ?? null;
    // create uploads row first to get the id
    const path0 = "pending"; // temp; will update after we have id
    const { data: row, error } = await admin.from("uploads")
      .insert({ conference_id: confId, filename, storage_path: path0, mime, size_bytes: size, status: "signing" })
      .select().single();
    if (error) return json({ error: "upload_row_failed", detail: error.message }, 500);
    const uploadId = row.id;
    const path = `${confId}/${uploadId}-${sanitizeFilename(filename)}`;
    await admin.from("uploads").update({ storage_path: path }).eq("id", uploadId);

    const signed = await admin.storage.from(UPLOAD_BUCKET).createSignedUploadUrl(path);
    if (signed.error || !signed.data) {
      await admin.from("uploads").delete().eq("id", uploadId);
      return json({ error: "sign_failed", detail: signed.error?.message ?? "no data" }, 500);
    }
    // signed.data = { signedUrl, token, path }. Build the absolute PUT url per the
    // signed-upload protocol so the browser can PUT the raw bytes directly.
    const token = (signed.data as any).token;
    const signedUrl = `${SUPABASE_URL}/storage/v1/object/upload/sign/${UPLOAD_BUCKET}/${path}?token=${token}`;
    return json({ uploadId, path, signedUrl, token });
  }

  if (rest[0] === "uploads" && rest[2] === "complete" && rest.length === 3 && method === "POST") {
    const uploadId = decodeURIComponent(rest[1]);
    const { data: row } = await admin.from("uploads").select("*").eq("id", uploadId).eq("conference_id", confId).maybeSingle();
    if (!row) return json({ error: "upload_not_found" }, 404);
    // verify object exists
    const slash = row.storage_path.lastIndexOf("/");
    const dir = slash >= 0 ? row.storage_path.slice(0, slash) : "";
    const base = slash >= 0 ? row.storage_path.slice(slash + 1) : row.storage_path;
    const { data: listed, error: listErr } = await admin.storage.from(UPLOAD_BUCKET).list(dir, { search: base, limit: 100 });
    if (listErr) return json({ error: "verify_failed", detail: listErr.message }, 500);
    const found = (listed ?? []).some((o: any) => o.name === base);
    if (!found) return json({ error: "object_missing", path: row.storage_path }, 400);
    const { data: updated } = await admin.from("uploads").update({ status: "uploaded" }).eq("id", uploadId).select().single();
    return json({ ok: true, upload: updated ?? row });
  }

  // ---- imports ----
  if (rest[0] === "imports" && rest[1] === "process" && rest.length === 2 && method === "POST") {
    const b = await readBody();
    const uploadId = b?.uploadId;
    if (!uploadId) return json({ error: "uploadId_required" }, 400);
    return await processUpload(confId, String(uploadId));
  }

  if (rest[0] === "imports" && rest[1] === "draft" && rest.length === 2 && method === "GET") {
    const row = await getActiveDraft(confId);
    if (!row) return json({ draft: null });
    return json({ draft: { id: row.id, status: row.status, summary: row.summary, data: row.data } });
  }

  if (rest[0] === "imports" && rest[1] === "commit" && rest.length === 2 && method === "POST") {
    const b = await readBody();
    const mode = b?.mode === "append" ? "append" : "replace";
    return await commitDraft(confId, mode);
  }

  if (rest[0] === "imports" && rest[1] === "discard" && rest.length === 2 && method === "POST") {
    const row = await getActiveDraft(confId);
    if (!row) return json({ ok: true, note: "no active draft" });
    await admin.from("import_drafts").update({ status: "discarded", updated_at: now() }).eq("id", row.id);
    return json({ ok: true });
  }

  return null; // not an import route
}
