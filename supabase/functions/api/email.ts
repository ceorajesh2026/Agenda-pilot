// AgendaPilot — real email delivery via Resend.
//
// The publish flow (index.ts doPublish) builds outbox_emails rows and then calls
// dispatchEmails() here. Delivery is governed by an email `mode` stored in
// app_settings:
//   - simulate → do nothing; rows keep delivery_status 'simulated' (default).
//   - test     → redirect a small sample (first 3 personal + the broadcast) to a
//                single test inbox, with the PDF attached; remaining rows skipped.
//   - live     → personal rows go to their real address (PDF attached); the
//                broadcast row fans out to every reachable person via the Resend
//                batch endpoint (no attachment — a public PDF link is appended).
//
// EVERY send path is wrapped so a Resend outage can never break publish: failures
// are recorded on the row's delivery_status and publish still returns 200.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PDF_BUCKET = "ap-pdfs";
const RESEND_URL = "https://api.resend.com/emails";
const RESEND_BATCH_URL = "https://api.resend.com/emails/batch";
const MAX_ATTACH_BYTES = 6 * 1024 * 1024; // Resend individual attachment ceiling we honor
const BATCH_SIZE = 100; // Resend batch endpoint max
const BATCH_PAUSE_MS = 700; // stay under the ~2 req/s free-tier limit
const TEST_SAMPLE = 3; // first N personal rows in test mode

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_FROM = "AgendaPilot <onboarding@resend.dev>";
export type EmailMode = "simulate" | "test" | "live";

export type EmailSettings = {
  api_key: string | null;
  from: string;
  mode: EmailMode;
  test_address: string;
};

// ---------------------------------------------------------------------------
// settings — stored across four app_settings keys.
// ---------------------------------------------------------------------------
export async function loadEmailSettings(): Promise<EmailSettings> {
  const { data } = await admin
    .from("app_settings")
    .select("key,value")
    .in("key", ["resend_api_key", "email_from", "email_mode", "email_test_address"]);
  const map = new Map<string, string>((data ?? []).map((r: any) => [r.key, r.value]));
  const modeRaw = map.get("email_mode");
  const mode: EmailMode =
    modeRaw === "test" || modeRaw === "live" || modeRaw === "simulate" ? modeRaw : "simulate";
  return {
    api_key: map.get("resend_api_key") ?? null,
    from: map.get("email_from") ?? DEFAULT_FROM,
    mode,
    test_address: map.get("email_test_address") ?? "",
  };
}

async function setSetting(key: string, value: string) {
  const { error } = await admin
    .from("app_settings")
    .upsert({ key, value, updated_at: nowIso() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Resend HTTP helpers
// ---------------------------------------------------------------------------
type SendResult = { ok: true; id: string | null } | { ok: false; detail: string };

async function resendSend(key: string, payload: Record<string, unknown>): Promise<SendResult> {
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
    if (!res.ok) {
      const msg = parsed?.message || parsed?.error || text || `HTTP ${res.status}`;
      return { ok: false, detail: `Resend ${res.status}: ${String(msg).slice(0, 400)}` };
    }
    return { ok: true, id: parsed?.id ?? null };
  } catch (err) {
    return { ok: false, detail: `Resend request failed: ${String((err as Error)?.message ?? err)}` };
  }
}

// Batch endpoint: body is an ARRAY. Returns per-request ids (order preserved) or an error.
async function resendBatch(
  key: string,
  items: Record<string, unknown>[],
): Promise<{ ok: true; ids: (string | null)[] } | { ok: false; detail: string }> {
  try {
    const res = await fetch(RESEND_BATCH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(items),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* raw */ }
    if (!res.ok) {
      const msg = parsed?.message || parsed?.error || text || `HTTP ${res.status}`;
      return { ok: false, detail: `Resend ${res.status}: ${String(msg).slice(0, 400)}` };
    }
    const arr = Array.isArray(parsed?.data) ? parsed.data : [];
    return { ok: true, ids: arr.map((d: any) => d?.id ?? null) };
  } catch (err) {
    return { ok: false, detail: `Resend batch failed: ${String((err as Error)?.message ?? err)}` };
  }
}

// Download the revised-agenda PDF as base64 (or null if too big / missing).
async function pdfBase64(pdfPath: string | null): Promise<{ b64: string; name: string } | null> {
  if (!pdfPath) return null;
  try {
    const dl = await admin.storage.from(PDF_BUCKET).download(pdfPath);
    if (dl.error || !dl.data) return null;
    const buf = new Uint8Array(await dl.data.arrayBuffer());
    if (buf.byteLength >= MAX_ATTACH_BYTES) return null;
    // base64-encode in chunks to avoid call-stack limits on large buffers
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    }
    const name = pdfPath.split("/").pop() || "revised-agenda.pdf";
    return { b64: btoa(binary), name };
  } catch {
    return null;
  }
}

async function markRow(id: string, patch: Record<string, unknown>) {
  await admin.from("outbox_emails").update(patch).eq("id", id);
}

// Public helpers exported for the /settings/email endpoint (index.ts owns routing).
export const emailSettingsStore = { loadEmailSettings, setSetting };

// ---------------------------------------------------------------------------
// dispatch — called from doPublish after outbox rows are inserted.
// `rows` are the freshly-inserted outbox_emails rows (must include id + fields).
// `pdfUrl` is the public URL of the revised PDF (for the broadcast link in live).
// Returns a short status string for the publication's 'Email outbox' target.
// ---------------------------------------------------------------------------
export async function dispatchEmails(
  rows: any[],
  ctx: { conferenceId: string; pdfPath: string | null; pdfUrl: string | null; from?: string },
): Promise<{ target: string; mode: EmailMode }> {
  const settings = await loadEmailSettings();
  const from = ctx.from || settings.from || DEFAULT_FROM;

  if (settings.mode === "simulate") {
    // leave rows as 'simulated' (their default)
    return { target: "queued (simulated)", mode: "simulate" };
  }

  const key = settings.api_key;
  if (!key) {
    // Misconfigured (mode set without a key). Record failure but never throw.
    for (const r of rows) {
      await markRow(r.id, {
        delivery_status: "failed",
        delivery_detail: "no Resend API key configured",
      }).catch(() => {});
    }
    return { target: "failed", mode: settings.mode };
  }

  const personal = rows.filter((r) => r.kind === "personal");
  const broadcast = rows.find((r) => r.kind === "broadcast") ?? null;

  try {
    if (settings.mode === "test") {
      return { target: await dispatchTest(key, from, rows, personal, broadcast, ctx), mode: "test" };
    }
    return { target: await dispatchLive(key, from, personal, broadcast, ctx), mode: "live" };
  } catch (err) {
    // last-ditch guard — should never surface, but publish must survive
    const detail = String((err as Error)?.message ?? err).slice(0, 300);
    for (const r of rows) {
      await markRow(r.id, { delivery_status: "failed", delivery_detail: detail }).catch(() => {});
    }
    return { target: "failed", mode: settings.mode };
  }
}

// TEST: at most (first 3 personal + broadcast), all redirected to test_address,
// subject prefixed, PDF attached, individual /emails calls. Remaining → skipped_test.
async function dispatchTest(
  key: string,
  from: string,
  allRows: any[],
  personal: any[],
  broadcast: any | null,
  ctx: { conferenceId: string; pdfPath: string | null; pdfUrl: string | null },
): Promise<string> {
  const settings = await loadEmailSettings();
  const to = settings.test_address;
  if (!to) {
    for (const r of allRows) {
      await markRow(r.id, { delivery_status: "failed", delivery_detail: "no test_address configured" });
    }
    return "failed";
  }

  const chosen: any[] = [...personal.slice(0, TEST_SAMPLE)];
  if (broadcast) chosen.push(broadcast);
  const chosenIds = new Set(chosen.map((r) => r.id));

  const pdf = await pdfBase64(ctx.pdfPath);
  let sent = 0;
  let failed = 0;

  for (const r of chosen) {
    const subject = `[TEST — would go to: ${r.to_label}] ${r.subject}`;
    const payload: Record<string, unknown> = {
      from,
      to: [to],
      subject,
      text: r.body,
    };
    if (pdf) payload.attachments = [{ filename: pdf.name, content: pdf.b64 }];
    const res = await resendSend(key, payload);
    if (res.ok) {
      sent++;
      await markRow(r.id, {
        delivery_status: "sent_test",
        provider_id: res.id,
        delivered_at: nowIso(),
        delivery_detail: `redirected to ${to}`,
      });
    } else {
      failed++;
      await markRow(r.id, { delivery_status: "failed", delivery_detail: res.detail });
    }
    await sleep(BATCH_PAUSE_MS); // respect free-tier ~2 req/s
  }

  // remaining rows → skipped_test
  for (const r of allRows) {
    if (chosenIds.has(r.id)) continue;
    await markRow(r.id, { delivery_status: "skipped_test", delivery_detail: "not part of test sample" });
  }

  if (sent > 0 && failed === 0) return "sent to test inbox";
  if (sent > 0) return "sent to test inbox (partial)";
  return "failed";
}

// LIVE: personal → real address with PDF; null address → no_address.
// broadcast → batch to all reachable_email people, PDF link appended, no attachment.
async function dispatchLive(
  key: string,
  from: string,
  personal: any[],
  broadcast: any | null,
  ctx: { conferenceId: string; pdfPath: string | null; pdfUrl: string | null },
): Promise<string> {
  const pdf = await pdfBase64(ctx.pdfPath);
  let personalSent = 0;
  let personalFailed = 0;

  for (const r of personal) {
    if (!r.address) {
      await markRow(r.id, { delivery_status: "no_address", delivery_detail: "recipient has no email on file" });
      continue;
    }
    const payload: Record<string, unknown> = {
      from,
      to: [r.address],
      subject: r.subject,
      text: r.body,
    };
    if (pdf) payload.attachments = [{ filename: pdf.name, content: pdf.b64 }];
    const res = await resendSend(key, payload);
    if (res.ok) {
      personalSent++;
      await markRow(r.id, {
        delivery_status: "sent",
        provider_id: res.id,
        delivered_at: nowIso(),
      });
    } else {
      personalFailed++;
      await markRow(r.id, { delivery_status: "failed", delivery_detail: res.detail });
    }
    await sleep(BATCH_PAUSE_MS);
  }

  // broadcast fan-out
  if (broadcast) {
    await dispatchBroadcastLive(key, from, broadcast, ctx);
  }

  const bits: string[] = [];
  if (personal.length) bits.push(`${personalSent}/${personal.length} personal sent`);
  if (personalFailed) bits.push(`${personalFailed} failed`);
  return bits.length ? `sent (${bits.join(", ")})` : "sent";
}

async function dispatchBroadcastLive(
  key: string,
  from: string,
  broadcast: any,
  ctx: { conferenceId: string; pdfPath: string | null; pdfUrl: string | null },
): Promise<void> {
  // Collect real emails of every reachable person (emails[0] each).
  const { data: people } = await admin
    .from("people")
    .select("emails,reachable_email")
    .eq("conference_id", ctx.conferenceId)
    .eq("reachable_email", true);

  const emails: string[] = [];
  const seen = new Set<string>();
  for (const p of people ?? []) {
    const arr = Array.isArray(p.emails) ? p.emails : [];
    const first = arr[0];
    if (typeof first === "string" && first.includes("@") && !seen.has(first)) {
      seen.add(first);
      emails.push(first);
    }
  }

  if (!emails.length) {
    await markRow(broadcast.id, {
      delivery_status: "sent",
      delivered_at: nowIso(),
      delivery_detail: "no reachable recipients",
    });
    return;
  }

  // Broadcast body gets a prominent PDF download link instead of an attachment.
  const linkLine = ctx.pdfUrl ? `\n\nDownload the revised agenda (PDF): ${ctx.pdfUrl}` : "";
  const body = (broadcast.body || "") + linkLine;

  const chunks: string[][] = [];
  for (let i = 0; i < emails.length; i += BATCH_SIZE) chunks.push(emails.slice(i, i + BATCH_SIZE));

  let delivered = 0;
  const failures: string[] = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const items = chunks[ci].map((addr) => ({
      from,
      to: [addr],
      subject: broadcast.subject,
      text: body,
    }));
    const res = await resendBatch(key, items);
    if (res.ok) {
      delivered += res.ids.length ? res.ids.length : items.length;
    } else {
      failures.push(`batch ${ci + 1}: ${res.detail}`);
    }
    if (ci < chunks.length - 1) await sleep(BATCH_PAUSE_MS);
  }

  if (failures.length === 0) {
    await markRow(broadcast.id, {
      delivery_status: "sent",
      delivered_at: nowIso(),
      delivery_detail: `delivered to ${delivered} recipients in ${chunks.length} batches`,
    });
  } else if (delivered > 0) {
    await markRow(broadcast.id, {
      delivery_status: "partial",
      delivered_at: nowIso(),
      delivery_detail:
        `delivered to ${delivered}/${emails.length} recipients in ${chunks.length} batches; ` +
        failures.slice(0, 3).join(" | ").slice(0, 350),
    });
  } else {
    await markRow(broadcast.id, {
      delivery_status: "failed",
      delivery_detail: failures.slice(0, 3).join(" | ").slice(0, 400),
    });
  }
}
