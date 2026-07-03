// Client for the prose seam. Sends the VALIDATED deterministic plan to POST /c/:id/prose,
// which asks Claude to write the rationale + notification copy. If the server is absent or
// has no API key, callers fall back to the templated copy — the disruption loop never
// depends on the network being up (PRD offline-tolerance).
import { fmtMin } from './data';
import { apiGet, apiPost } from './api';
import type { AgentOption, Disruption } from './agent';

export interface ProseHealth { available: boolean; model: string | null; }

export async function proseHealth(): Promise<ProseHealth> {
  const out = await apiGet<ProseHealth>('/prose/health');
  return out ?? { available: false, model: null };
}

// Returns a copy of the option with Claude-written rationale + messages, or null on any failure.
// `disruptedName` is the disrupted speaker's display name (resolved from context by the caller).
export async function enhanceProse(
  confId: string,
  option: AgentOption,
  dis: Disruption,
  disruptedName: string,
): Promise<AgentOption | null> {
  const facts = {
    option_kind: option.kind,
    disrupted_speaker: {
      name: disruptedName,
      status: dis.kind === 'cancel' ? 'cancelled' : `delayed, arriving ~${fmtMin(dis.etaMin ?? 0)}`,
      reason: dis.reason,
    },
    change: option.diff.map((d) => ({ what: d.label, from: d.before, to: d.after })),
    recipients: option.notifications.map((n, i) => ({
      id: String(i), to: n.to, channel: n.channel, critical: n.critical, draft_seed: n.message,
    })),
  };
  const out = await apiPost<{ rationale?: string; notifications?: { id: string; message: string }[] }>(
    `/c/${confId}/prose`, { facts },
  );
  if (!out || !out.rationale || !Array.isArray(out.notifications)) return null;
  const byId = new Map(out.notifications.map((n) => [n.id, n.message]));
  return {
    ...option,
    rationale: out.rationale,
    notifications: option.notifications.map((n, i) => ({ ...n, message: byId.get(String(i)) ?? n.message })),
    llm: true,
  };
}
