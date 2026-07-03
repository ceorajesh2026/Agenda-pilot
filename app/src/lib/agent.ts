// M3 — the disruption agent. Deterministic option generation ("AI proposes"), every
// candidate validated by the M2 constraint engine ("rules verify"). The natural-language
// rationale + notification copy are templated here behind a seam where the Claude API
// plugs in (see draftRationale / draftMessage — mark: LLM_SEAM).
import type { Seed, Session, Person, Role } from './types';
import { fmtMin } from './data';
import { runConstraints } from './constraints';
import type { Finding } from './constraints';

// Local person index for a given seed — the pure agent functions build this instead of
// depending on a module-level map, so they stay parameterized and work per conference.
function peopleIndex(seed: Seed): Map<string, Person> {
  return new Map(seed.people.map((p) => [p.id, p]));
}

export type DisruptionKind = 'delay' | 'cancel';
export type Checkin = 'On-site' | 'In transit' | 'Delayed' | 'Confirmed' | 'Cancelled' | 'Unknown';

export interface Disruption {
  personId: string;
  kind: DisruptionKind;
  etaMin: number | null;   // new arrival time (delay only)
  reason: string;
  reportedAtMin: number;
}

// ---- delta ops applied to a working copy of the schedule for validation ----
type Op =
  | { op: 'reschedule'; sessionId: string; start_min: number; end_min: number }
  | { op: 'substitute'; sessionId: string; fromPersonId: string; toPersonId: string }
  | { op: 'absorb'; sessionId: string };

export interface DiffRow { label: string; before: string; after: string; tone: 'red' | 'amber' | 'green'; }

export interface DraftNotification {
  to: string;              // person name or synthetic recipient (e.g. "Hall A AV")
  personId?: string;
  channel: 'email' | 'whatsapp' | 'sms' | 'phone-call';
  critical: boolean;
  message: string;
  ack: boolean;
}

export interface AgentOption {
  id: string;
  kind: 'swap' | 'substitute' | 'absorb';
  title: string;
  rationale: string;
  delta: Op[];
  valid: boolean;
  invalidReason?: string;
  score: number;                 // lower = less disruptive
  scoreParts: { radius: number; audience: number; notify: number; criticality: number };
  diff: DiffRow[];
  notifications: DraftNotification[];
  recommended: boolean;
  llm?: boolean;   // true once rationale/notifications were rewritten by Claude
}

// ---------------------------------------------------------------- check-in (simulated)
// Demo signal in lieu of the F2 layered check-in feed. National reachable faculty are
// assumed on-site; international are in transit. Overridden by an active disruption.
export function checkin(p: Person, dis?: Disruption): Checkin {
  if (dis && dis.personId === p.id) return dis.kind === 'cancel' ? 'Cancelled' : 'Delayed';
  if (p.declined) return 'Cancelled';
  const intl = p.segments.some((s) => s.includes('International'));
  if (!p.reachable_email && !p.reachable_wa_sms) return 'Unknown';
  return intl ? 'In transit' : 'On-site';
}

// ---------------------------------------------------------------- helpers
function rolesOf(seed: Seed, personId: string): Role[] {
  return seed.roles.filter((r) => r.person_id === personId);
}

export function impactSet(seed: Seed, dis: Disruption): { sessions: Session[]; roles: Role[] } {
  const roles = rolesOf(seed, dis.personId).filter((r) => {
    const s = seed.sessions.find((x) => x.id === r.session_id);
    if (!s || s.start_min == null) return false;
    if (dis.kind === 'cancel') return true;
    return dis.etaMin == null ? true : s.start_min < dis.etaMin; // can't arrive in time
  });
  const ids = new Set(roles.map((r) => r.session_id));
  const sessions = seed.sessions.filter((s) => ids.has(s.id));
  return { sessions, roles };
}

// ---------------------------------------------------------------- validation
function applyDelta(seed: Seed, delta: Op[]): Seed {
  const sessions = seed.sessions.map((s) => ({ ...s }));
  let roles = seed.roles.map((r) => ({ ...r }));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const op of delta) {
    if (op.op === 'reschedule') {
      const s = byId.get(op.sessionId);
      if (s) { s.start_min = op.start_min; s.end_min = op.end_min; s.start = fmtMin(op.start_min); s.end = fmtMin(op.end_min); s.state = 'REVISED'; }
    } else if (op.op === 'substitute') {
      roles = roles.map((r) => (r.session_id === op.sessionId && r.person_id === op.fromPersonId
        ? { ...r, person_id: op.toPersonId, match: 'exact' as const } : r));
    } else if (op.op === 'absorb') {
      const s = byId.get(op.sessionId);
      if (s) { s.state = 'CANCELLED'; s.type = 'break'; }
    }
  }
  return { ...seed, sessions, roles };
}

function key(f: Finding): string { return `${f.category}|${[...f.sessionIds].sort().join(',')}|${f.personId ?? ''}`; }

function validate(seed: Seed, delta: Op[]): { valid: boolean; reason?: string } {
  const before = new Set(runConstraints(seed).filter((f) => f.severity === 'error').map(key));
  const after = runConstraints(applyDelta(seed, delta)).filter((f) => f.severity === 'error');
  const introduced = after.filter((f) => !before.has(key(f)));
  if (introduced.length) return { valid: false, reason: introduced[0].title };
  return { valid: true };
}

// ---------------------------------------------------------------- LLM_SEAM: prose
// Templated today; swap these two functions for Claude API calls (structured output) to
// get richer, context-aware rationale + notification copy. Signature stays identical.
function draftRationale(kind: AgentOption['kind'], dis: Disruption, s: Session, extra: string, who: string): string {
  if (kind === 'swap') return `${who} can't reach the venue before ${fmtMin(dis.etaMin ?? 0)}. Moving "${s.title}" later ${extra} keeps ${who} on the programme and only shifts already-on-site speakers earlier — smallest audience impact.`;
  if (kind === 'substitute') return `Rather than move the slot, cover "${s.title}" with a pre-approved backup ${extra}. ${who}'s talk is preserved in content but delivered by a stand-in; no time change, but attendees lose the featured speaker.`;
  return `If no swap or substitute fits, absorb "${s.title}" into the adjacent break / extend the neighbouring Q&A ${extra}. Least logistics, highest content loss.`;
}

function channelFor(p?: Person): DraftNotification['channel'] {
  if (!p) return 'email';
  if (p.reachable_wa_sms) return 'whatsapp';
  if (p.reachable_email) return 'email';
  return 'phone-call';
}

function draftMessage(p: Person | undefined, name: string, body: string): DraftNotification {
  return { to: name, personId: p?.id, channel: channelFor(p), critical: false, message: body, ack: false };
}

// ---------------------------------------------------------------- generators
function moderatorsOf(seed: Seed, sessionId: string): Role[] {
  return seed.roles.filter((r) => r.session_id === sessionId
    && ['moderator', 'grand_master', 'quiz_master', 'workshop_director'].includes(r.role_type));
}

function buildSwap(seed: Seed, dis: Disruption, s: Session): AgentOption | null {
  if (s.start_min == null || s.end_min == null || dis.etaMin == null) return null;
  const peopleById = peopleIndex(seed);
  // Candidate targets: later same-day, same-hall, non-locked sessions starting at/after the
  // ETA, whose speakers are all on-site (so pulling them earlier is safe). We EXCHANGE the two
  // sessions' full time windows (both already fit the grid) and keep the first that the
  // constraint checker accepts — never a naive move that overflows into the next session.
  const targets = seed.sessions.filter((t) => t.id !== s.id && t.date === s.date && t.hall_id === s.hall_id
    && t.type === 'session' && !t.locked && t.start_min != null && t.end_min != null && t.start_min >= dis.etaMin!)
    .sort((a, b) => a.start_min! - b.start_min!);
  for (const t of targets) {
    const speakers = seed.roles.filter((r) => r.session_id === t.id && r.person_id)
      .map((r) => peopleById.get(r.person_id!)!).filter(Boolean);
    if (!speakers.every((p) => checkin(p) === 'On-site')) continue;
    const delta: Op[] = [
      { op: 'reschedule', sessionId: s.id, start_min: t.start_min!, end_min: t.end_min! },
      { op: 'reschedule', sessionId: t.id, start_min: s.start_min!, end_min: s.end_min! },
    ];
    const v = validate(seed, delta);
    if (!v.valid) continue;
    const diff: DiffRow[] = [
      { label: `"${s.title}"`, before: `${s.start}–${s.end}`, after: `${t.start}–${t.end}`, tone: 'amber' },
      { label: `"${t.title}"`, before: `${t.start}–${t.end}`, after: `${s.start}–${s.end}`, tone: 'amber' },
    ];
    const person = peopleById.get(dis.personId);
    const notes: DraftNotification[] = [];
    if (person) { const n = draftMessage(person, person.name, `Your talk "${s.title}" moves from ${s.start} to ${t.start} in ${hallName(seed, s.hall_id)}.`); n.critical = true; notes.push(n); }
    for (const m of speakers) notes.push(draftMessage(m, m.name, `Your talk "${t.title}" moves EARLIER, from ${t.start} to ${s.start} in ${hallName(seed, s.hall_id)}.`));
    for (const r of [...moderatorsOf(seed, s.id), ...moderatorsOf(seed, t.id)]) { const mp = r.person_id ? peopleById.get(r.person_id) : undefined; notes.push(draftMessage(mp, mp?.name ?? r.name_raw, `Running order changed: "${s.title}" ↔ "${t.title}". Please re-brief.`)); }
    notes.push({ to: `${hallName(seed, s.hall_id)} AV`, channel: 'whatsapp', critical: false, ack: false, message: `Slide/AV order changed for two sessions — reload in new order.` });
    return finalize({
      id: 'opt-swap', kind: 'swap', title: `Swap "${s.title}" with "${t.title}"`,
      rationale: draftRationale('swap', dis, s, `(to ${t.start}, swapping windows with "${t.title}" — both speakers already on-site)`, person?.name ?? 'The speaker'),
      delta, valid: true, diff, notifications: notes,
      scoreParts: { radius: speakers.length * 2, audience: 2 * 5, notify: notes.length, criticality: 0 },
    });
  }
  return null;
}

function buildSubstitute(seed: Seed, dis: Disruption, s: Session): AgentOption | null {
  const peopleById = peopleIndex(seed);
  const person = peopleById.get(dis.personId);
  if (!person) return null;
  const sub = bestSubstitute(seed, person, s);
  if (!sub) return null;
  const delta: Op[] = [{ op: 'substitute', sessionId: s.id, fromPersonId: person.id, toPersonId: sub.id }];
  const v = validate(seed, delta);
  const featured = /featured|keynote/i.test(s.title);
  const diff: DiffRow[] = [
    { label: `"${s.title}" speaker`, before: person.name, after: `${sub.name} (backup)`, tone: 'amber' },
    { label: 'Time', before: `${s.start}–${s.end}`, after: `${s.start}–${s.end} (unchanged)`, tone: 'green' },
  ];
  const notes: DraftNotification[] = [];
  const ns = draftMessage(sub, sub.name, `Can you cover "${s.title}" at ${s.start} in ${hallName(seed, s.hall_id)}? You are the pre-approved backup for this topic.`);
  ns.critical = true; notes.push(ns);
  if (person) notes.push(draftMessage(person, person.name, `Your slot "${s.title}" (${s.start}) will be covered by a backup as you're delayed. No action needed.`));
  for (const r of moderatorsOf(seed, s.id)) { const mp = r.person_id ? peopleById.get(r.person_id) : undefined; notes.push(draftMessage(mp, mp?.name ?? r.name_raw, `Speaker change for "${s.title}": ${sub.name} covers for ${person.name}.`)); }
  return finalize({
    id: 'opt-sub', kind: 'substitute', title: `Substitute ${sub.name} (backup pool)`,
    rationale: draftRationale('substitute', dis, s, `(${sub.name}, ${sub.speciality || 'same topic area'}, on-site)`, person.name),
    delta, valid: v.valid, invalidReason: v.reason, diff, notifications: notes,
    scoreParts: { radius: 0, audience: (featured ? 4 : 2) * 5, notify: notes.length, criticality: featured ? 3 : 0 },
  });
}

function buildAbsorb(seed: Seed, dis: Disruption, s: Session): AgentOption {
  const peopleById = peopleIndex(seed);
  const delta: Op[] = [{ op: 'absorb', sessionId: s.id }];
  const v = validate(seed, delta);
  const featured = /featured|keynote/i.test(s.title);
  const person = peopleById.get(dis.personId);
  const diff: DiffRow[] = [{ label: `"${s.title}"`, before: `${s.start}–${s.end} talk`, after: 'absorbed into adjacent break / extended Q&A', tone: 'red' }];
  const notes: DraftNotification[] = [];
  for (const r of moderatorsOf(seed, s.id)) { const mp = r.person_id ? peopleById.get(r.person_id) : undefined; notes.push(draftMessage(mp, mp?.name ?? r.name_raw, `"${s.title}" is dropped (speaker unavailable, no substitute) — extend the surrounding session / Q&A.`)); }
  if (person) notes.push(draftMessage(person, person.name, `Your slot "${s.title}" has been absorbed as no swap/substitute was possible. Sorry to miss you.`));
  notes.push({ to: `${hallName(seed, s.hall_id)} AV`, channel: 'whatsapp', critical: false, ack: false, message: `"${s.title}" removed from the running order.` });
  return finalize({
    id: 'opt-absorb', kind: 'absorb', title: `Absorb / compress "${s.title}"`,
    rationale: draftRationale('absorb', dis, s, '', person?.name ?? 'The speaker'),
    delta, valid: v.valid, invalidReason: v.reason, diff, notifications: notes,
    scoreParts: { radius: 0, audience: (featured ? 5 : 3) * 5, notify: notes.length, criticality: featured ? 2 : 0 },
  });
}

// Provisional backup pool (real per-topic nominations, PRD Open Q4, replace this): derive the
// topic from the disrupted talk's own slot title, then draw candidates from faculty who speak
// on the SAME topic elsewhere in the programme — on-site, reachable, same discipline.
const TOPIC_STEMS = ['autoimmun', 'antibod', 'encephal', 'myasthen', 'movement', 'parkinson', 'dyskines',
  'dyston', 'tremor', 'ataxia', 'epilep', 'seizure', 'stroke', 'vascular', 'thrombol', 'demyelin',
  'sclerosis', 'nmosd', 'mogad', 'dementia', 'cognitive', 'alzheimer', 'headache', 'migraine', 'vertigo',
  'dizz', 'ophthalm', 'vision', 'optic', 'neuropath', 'neuromuscul', 'myopath', 'muscle', 'infection',
  'meningitis', 'sleep', 'eeg', 'nerve'];

function bestSubstitute(seed: Seed, person: Person, s: Session): Person | undefined {
  const peopleById = peopleIndex(seed);
  const mySlots = new Set(seed.roles.filter((r) => r.session_id === s.id && r.person_id === person.id && r.slot_id).map((r) => r.slot_id!));
  const slotText = seed.slots.filter((sl) => mySlots.has(sl.id)).map((sl) => sl.title).join(' ');
  const topicText = `${slotText} ${s.title} ${person.speciality}`.toLowerCase();
  const terms = TOPIC_STEMS.filter((w) => topicText.includes(w));
  const track = s.track;
  const isCand = (p: Person) => p.id !== person.id && !p.declined && (p.reachable_email || p.reachable_wa_sms)
    && checkin(p) === 'On-site' && p.segments.some((seg) => seg.startsWith(track === 'neurology' ? 'NR' : 'NS'));

  const scoreByPerson = new Map<string, number>();
  for (const r of seed.roles) {
    if (!r.person_id || r.session_id === s.id) continue;
    if (!['speaker', 'session_expert', 'panellist'].includes(r.role_type)) continue;
    const slot = r.slot_id ? seed.slots.find((sl) => sl.id === r.slot_id) : undefined;
    const sess = seed.sessions.find((x) => x.id === r.session_id);
    const text = `${slot?.title ?? ''} ${sess?.title ?? ''}`.toLowerCase();
    const m = terms.filter((w) => text.includes(w)).length;
    if (m > 0) scoreByPerson.set(r.person_id, Math.max(scoreByPerson.get(r.person_id) ?? 0, m));
  }
  const ranked = [...scoreByPerson.entries()]
    .map(([id, m]) => ({ p: peopleById.get(id), m }))
    .filter((x): x is { p: Person; m: number } => !!x.p && isCand(x.p))
    .sort((a, b) => b.m - a.m);
  if (ranked.length) return ranked[0].p;

  const spec = person.speciality.toLowerCase();
  const bySpec = spec ? seed.people.find((p) => isCand(p) && p.speciality.toLowerCase() === spec) : undefined;
  return bySpec ?? seed.people.find(isCand);
}

function hallName(seed: Seed, hid: string): string {
  return seed.halls.find((h) => h.id === hid)?.name ?? hid;
}

function finalize(o: Omit<AgentOption, 'score' | 'recommended'>): AgentOption {
  const { radius, audience, notify, criticality } = o.scoreParts;
  return { ...o, score: radius + audience + notify + criticality, recommended: false };
}

export function generateOptions(seed: Seed, dis: Disruption): { impact: ReturnType<typeof impactSet>; options: AgentOption[] } {
  const impact = impactSet(seed, dis);
  const primary = [...impact.sessions].sort((a, b) => (a.start_min ?? 0) - (b.start_min ?? 0))[0];
  if (!primary) return { impact, options: [] };
  const raw = [buildSwap(seed, dis, primary), buildSubstitute(seed, dis, primary), buildAbsorb(seed, dis, primary)]
    .filter((x): x is AgentOption => x != null);
  const valid = raw.filter((o) => o.valid).sort((a, b) => a.score - b.score);
  if (valid.length) valid[0].recommended = true;
  const invalid = raw.filter((o) => !o.valid);
  return { impact, options: [...valid, ...invalid] };
}
