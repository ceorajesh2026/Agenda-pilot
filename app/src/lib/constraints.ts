// Deterministic constraint engine (M2). Runs over the seed and returns findings.
// This is the "rules verify" half of "AI proposes, rules verify, humans approve":
// every future AI revision proposal must pass this same checker before a human sees it.
import type { Seed, Session, Role } from './types';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  id: string;
  severity: Severity;
  category: string;
  title: string;
  detail: string;
  sessionIds: string[];
  personId?: string;
}

const MOD_ROLES = new Set(['moderator', 'grand_master', 'quiz_master', 'workshop_director']);
const PANEL_ROLES = new Set(['session_expert', 'panellist', 'clinical_expert', 'pathology_expert']);
const NEEDS_MOD = /panel|quiz|rapid fire|grand rounds|clinico|debate|symposium|caf|challenge|discussion/i;

function overlaps(a: Session, b: Session): boolean {
  if (a.date !== b.date) return false;
  if (a.start_min == null || a.end_min == null || b.start_min == null || b.end_min == null) return false;
  return a.start_min < b.end_min && b.start_min < a.end_min;
}

export function runConstraints(seed: Seed): Finding[] {
  const findings: Finding[] = [];
  const peopleById = new Map(seed.people.map((p) => [p.id, p]));
  const rolesBySession = new Map<string, Role[]>();
  for (const r of seed.roles) {
    const a = rolesBySession.get(r.session_id) ?? [];
    a.push(r);
    rolesBySession.set(r.session_id, a);
  }
  const sessById = new Map(seed.sessions.map((s) => [s.id, s]));
  let n = 0;
  const nid = () => `f${++n}`;

  // 1) Person double-booking — the core "no person in two places at once".
  const personSessions = new Map<string, Set<string>>();
  for (const r of seed.roles) {
    if (!r.person_id) continue;
    const s = sessById.get(r.session_id);
    if (!s || s.start_min == null) continue;
    const set = personSessions.get(r.person_id) ?? new Set<string>();
    set.add(r.session_id);
    personSessions.set(r.person_id, set);
  }
  for (const [pid, sset] of personSessions) {
    const list = [...sset].map((id) => sessById.get(id)!).filter(Boolean);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (overlaps(list[i], list[j])) {
          const nm = peopleById.get(pid)?.name ?? pid;
          findings.push({
            id: nid(), severity: 'error', category: 'Double-booking', personId: pid,
            title: `${nm} is double-booked`,
            detail: `"${list[i].title}" (${list[i].start}–${list[i].end}) overlaps "${list[j].title}" (${list[j].start}–${list[j].end}) on ${list[i].date}.`,
            sessionIds: [list[i].id, list[j].id],
          });
        }
      }
    }
  }

  // 2) Hall double-booking — two sessions in the same hall at the same time.
  const byHall = new Map<string, Session[]>();
  for (const s of seed.sessions) {
    const a = byHall.get(s.hall_id) ?? [];
    a.push(s);
    byHall.set(s.hall_id, a);
  }
  for (const [hid, list] of byHall) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (overlaps(list[i], list[j])) {
          findings.push({
            id: nid(), severity: 'error', category: 'Hall clash',
            title: `Hall clash in ${seed.halls.find((h) => h.id === hid)?.name ?? hid}`,
            detail: `"${list[i].title}" and "${list[j].title}" overlap on ${list[i].date}.`,
            sessionIds: [list[i].id, list[j].id],
          });
        }
      }
    }
  }

  // 3) Missing moderator on panel-type sessions.
  for (const s of seed.sessions) {
    if (s.type === 'break' || s.state === 'DRAFT') continue;
    const rs = rolesBySession.get(s.id) ?? [];
    const hasMod = rs.some((r) => MOD_ROLES.has(r.role_type));
    const hasPanel = rs.some((r) => PANEL_ROLES.has(r.role_type));
    if (!hasMod && (hasPanel || NEEDS_MOD.test(s.title))) {
      findings.push({
        id: nid(), severity: 'warning', category: 'Missing moderator',
        title: `No moderator: ${s.title}`,
        detail: `This ${s.date} session looks like it needs a chair/moderator but none is assigned.`,
        sessionIds: [s.id],
      });
    }
  }

  // 4) Session duration integrity (±10 min) where slot durations are known.
  for (const s of seed.sessions) {
    if (s.start_min == null || s.end_min == null) continue;
    const durs = seed.slots.filter((sl) => sl.session_id === s.id && sl.duration_min != null);
    if (durs.length < 2) continue;
    const sum = durs.reduce((a, sl) => a + (sl.duration_min ?? 0), 0);
    const window = s.end_min - s.start_min;
    if (Math.abs(sum - window) > 10) {
      findings.push({
        id: nid(), severity: 'warning', category: 'Duration mismatch',
        title: `Timing drift: ${s.title}`,
        detail: `Slot durations sum to ${sum} min but the window is ${window} min (${s.start}–${s.end}).`,
        sessionIds: [s.id],
      });
    }
  }

  // 5) Unresolved speakers — a named person the notification system can't reach.
  for (const r of seed.roles) {
    if (r.match === 'unmatched' || r.match === 'ambiguous') {
      const s = sessById.get(r.session_id);
      findings.push({
        id: nid(), severity: 'warning', category: 'Unlinked speaker',
        title: `"${r.name_raw}" not linked to a contact`,
        detail: `${r.match === 'ambiguous' ? 'Ambiguous match' : 'No directory match'} for a ${r.role_type.replace('_', ' ')} in "${s?.title ?? r.session_id}" — cannot be notified until linked.`,
        sessionIds: [r.session_id],
      });
    }
  }

  // 6) Assigned faculty with no reachable channel.
  const flaggedUnreachable = new Set<string>();
  for (const r of seed.roles) {
    if (!r.person_id || flaggedUnreachable.has(r.person_id)) continue;
    const p = peopleById.get(r.person_id);
    if (p && !p.reachable_email && !p.reachable_wa_sms) {
      flaggedUnreachable.add(r.person_id);
      findings.push({
        id: nid(), severity: 'warning', category: 'Unreachable faculty',
        title: `${p.name} has no contact channel`,
        detail: `Assigned to sessions but has neither a valid email nor a phone — a disruption to them cannot be pushed automatically.`,
        sessionIds: [r.session_id], personId: p.id,
      });
    }
  }

  // 7) Unassigned DRAFT slots (Spine Olympiad / Neuro-Odyssey backlog).
  const draftBy = new Map<string, number>();
  for (const s of seed.sessions) {
    if (s.state !== 'DRAFT') continue;
    const cnt = seed.slots.filter((sl) => sl.session_id === s.id).length;
    draftBy.set(s.track, (draftBy.get(s.track) ?? 0) + cnt);
  }
  for (const [track, cnt] of draftBy) {
    findings.push({
      id: nid(), severity: 'info', category: 'Unscheduled backlog',
      title: `${track}: ${cnt} topics with no time or speaker`,
      detail: `These DRAFT topics need scheduling and faculty assignment before they can be published or protected by the agent.`,
      sessionIds: [],
    });
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return findings;
}
