// Client for the distribution backend (Supabase Edge Function). On approval the app POSTs
// the approved revision to POST /c/:id/publish; the server applies it to the published
// agenda and propagates it to the website feed, ICS calendars, print program and WhatsApp
// groups. Every call is NULL-SAFE — if the server is down the app keeps its local (offline)
// revision, exactly as before.
import { apiGet, apiPost } from './api';
import type { AgentOption, Disruption } from './agent';

export interface PubTarget { name: string; channel: string; status: string; detail: string; }
export interface PubNotification { to: string; channel: string; status: string; }
export interface Publication {
  id: string; at: string; title: string; summary: string;
  targets: PubTarget[]; notifications: PubNotification[]; whatsapp: string;
  pdfUrl?: string | null; pdfName?: string | null;
}
export interface PublishResult { ok: boolean; publication: Publication; version: number; last_updated: string; }

export interface Changelog {
  version: number; last_updated: string;
  publications: {
    id: string; at: string; title: string; summary: string;
    targets: { name: string; status: string; detail: string }[];
    notifications: { to: string; channel: string; status: string }[];
    whatsapp: string;
    pdfUrl?: string | null; pdfName?: string | null;
  }[];
  feeds: { json: string; widget: string; embed: string; ics: string; print: { date: string; label: string; url: string }[] };
}

// ---- outbox + whatsapp feeds ----
export interface OutboxEmail {
  id: string; at: string; kind: 'personal' | 'broadcast';
  to: string; address?: string | null; toCount?: number; sample?: string[];
  subject: string; body: string;
  pdfUrl?: string | null; pdfName?: string | null; mailto?: string | null;
}
export interface Outbox { emails: OutboxEmail[]; }

export interface WhatsappPost {
  id: string; at: string; group: string; text: string;
  pdfName?: string | null; pdfUrl?: string | null;
}
export interface Whatsapp { posts: WhatsappPost[]; }

// `disruptedName` is the disrupted speaker's display name (resolved from context by caller).
export async function publishRevision(
  confId: string,
  option: AgentOption,
  dis: Disruption,
  disruptedName: string,
  dayDate?: string,
): Promise<PublishResult | null> {
  const payload = {
    kind: option.kind,
    title: option.title,
    summary: `${disruptedName} ${dis.kind === 'cancel' ? 'cancelled' : 'delayed'} — ${option.title}`,
    delta: option.delta,
    dayDate: dayDate ?? null,
    notifications: option.notifications.map((n) => ({ to: n.to, personId: n.personId, channel: n.channel, critical: n.critical, message: n.message })),
    actor: 'Secretariat',
  };
  return apiPost<PublishResult>(`/c/${confId}/publish`, payload);
}

export async function getChangelog(confId: string): Promise<Changelog | null> {
  return apiGet<Changelog>(`/c/${confId}/changelog`);
}

export async function getOutbox(confId: string): Promise<Outbox | null> {
  return apiGet<Outbox>(`/c/${confId}/outbox`);
}

export async function getWhatsapp(confId: string): Promise<Whatsapp | null> {
  return apiGet<Whatsapp>(`/c/${confId}/whatsapp`);
}
