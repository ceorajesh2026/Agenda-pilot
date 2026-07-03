// Agenda data layer. The app used to import a STATIC seed.json at module load; it now
// builds a Seed-shaped snapshot per conference from GET /c/:id/agenda and exposes it
// through a React context (useAgenda). buildAgenda() turns the API snapshot into the same
// Seed object + the same index maps the whole app already relied on, so consumers only
// swap their `import { seed, ... }` for `const { seed, ... } = useAgenda()`.
import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Seed, Person, Session, Slot, Role, Hall, Track, Day } from './types';

// ---- pure helpers (no module-level state) ----
export function fmtMin(min: number | null): string {
  if (min == null) return '--:--';
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function trackLabel(track: string): string {
  if (track === 'neurology') return 'Neurology';
  return track;
}

export const ROLE_LABEL: Record<string, string> = {
  speaker: 'Speaker', moderator: 'Moderator', grand_master: 'Grand Master',
  quiz_master: 'Quiz Master', session_expert: 'Session Expert', panellist: 'Panellist',
  clinical_expert: 'Clinical Expert', pathology_expert: 'Pathology Expert',
  workshop_director: 'Workshop Director',
};

// The snapshot returned by GET /c/:id/agenda. Only the agenda slices are guaranteed; the
// remaining Seed fields (event/tracks/…) are filled in with safe defaults by buildAgenda.
export interface AgendaSnapshotInput {
  conference?: { id: string; slug: string; name: string; start_date: string | null; end_date: string | null } | null;
  event?: Seed['event'];
  generated_note?: string;
  tracks?: Track[];
  days?: Day[];
  halls?: Hall[];
  people?: Person[];
  sessions?: Session[];
  slots?: Slot[];
  roles?: Role[];
  resolution_review?: Seed['resolution_review'];
  resolution_stats?: Seed['resolution_stats'];
}

// ---- the shape returned by buildAgenda / provided by useAgenda ----
export interface Agenda {
  confId: string;
  seed: Seed;
  peopleById: Map<string, Person>;
  sessionsById: Map<string, Session>;
  hallsById: Map<string, Hall>;
  slotsBySession: Map<string, Slot[]>;
  rolesBySession: Map<string, Role[]>;
  rolesByPerson: Map<string, Role[]>;
  personName: (r: Role) => string;
  fmtMin: typeof fmtMin;
  trackLabel: typeof trackLabel;
  ROLE_LABEL: typeof ROLE_LABEL;
}

// Derive the track list from the sessions when the snapshot doesn't ship one.
function deriveTracks(sessions: Session[], tracks?: Track[]): Track[] {
  if (tracks && tracks.length) return tracks;
  const ids = [...new Set(sessions.map((s) => s.track).filter(Boolean))];
  return ids.map((id) => ({ id, name: trackLabel(id), kind: id, status: 'finalized' }));
}

// Derive day pills from the sessions when the snapshot doesn't ship them.
function deriveDays(sessions: Session[], days?: Day[]): Day[] {
  if (days && days.length) return days;
  const dates = [...new Set(sessions.map((s) => s.date).filter((d): d is string => !!d))].sort();
  return dates.map((date) => ({ date, label: date }));
}

// Build a full Seed-shaped object + index maps from a /c/:id/agenda snapshot.
export function buildAgenda(input: AgendaSnapshotInput, confId: string): Agenda {
  const people = input.people ?? [];
  const sessions = input.sessions ?? [];
  const slots = input.slots ?? [];
  const roles = input.roles ?? [];
  const halls = input.halls ?? [];
  const tracks = deriveTracks(sessions, input.tracks);
  const days = deriveDays(sessions, input.days);

  const conf = input.conference;
  const event: Seed['event'] = input.event ?? {
    id: conf?.id ?? 'conference',
    name: conf?.name ?? 'Conference',
    start_date: conf?.start_date ?? days[0]?.date ?? '',
    end_date: conf?.end_date ?? days[days.length - 1]?.date ?? '',
    website: '',
  };

  const seed: Seed = {
    event,
    generated_note: input.generated_note ?? '',
    tracks,
    days,
    halls,
    people,
    sessions,
    slots,
    roles,
    resolution_review: input.resolution_review ?? [],
    resolution_stats: input.resolution_stats ?? {},
  };

  const peopleById = new Map<string, Person>(people.map((p) => [p.id, p]));
  const sessionsById = new Map<string, Session>(sessions.map((s) => [s.id, s]));
  const hallsById = new Map<string, Hall>(halls.map((h) => [h.id, h]));

  const slotsBySession = new Map<string, Slot[]>();
  for (const sl of slots) {
    const arr = slotsBySession.get(sl.session_id) ?? [];
    arr.push(sl);
    slotsBySession.set(sl.session_id, arr);
  }

  const rolesBySession = new Map<string, Role[]>();
  const rolesByPerson = new Map<string, Role[]>();
  for (const r of roles) {
    const a = rolesBySession.get(r.session_id) ?? [];
    a.push(r);
    rolesBySession.set(r.session_id, a);
    if (r.person_id) {
      const b = rolesByPerson.get(r.person_id) ?? [];
      b.push(r);
      rolesByPerson.set(r.person_id, b);
    }
  }

  const personName = (r: Role): string => {
    if (r.person_id) return peopleById.get(r.person_id)?.name ?? r.name_raw;
    return r.name_raw;
  };

  return {
    confId: confId || conf?.id || event.id,
    seed, peopleById, sessionsById, hallsById, slotsBySession, rolesBySession, rolesByPerson,
    personName, fmtMin, trackLabel, ROLE_LABEL,
  };
}

// ---- React context ----
const AgendaCtx = createContext<Agenda | null>(null);

export function AgendaProvider({ agenda, children }: { agenda: Agenda; children: ReactNode }) {
  // agenda is already memoized by the caller (built once per snapshot), pass it straight through.
  return <AgendaCtx.Provider value={agenda}>{children}</AgendaCtx.Provider>;
}

export function useAgenda(): Agenda {
  const v = useContext(AgendaCtx);
  if (!v) throw new Error('useAgenda must be used inside <AgendaProvider>');
  return v;
}

// Convenience hook for building an Agenda from a raw snapshot with stable identity.
export function useBuiltAgenda(input: AgendaSnapshotInput | null, confId: string): Agenda | null {
  return useMemo(() => (input ? buildAgenda(input, confId) : null), [input, confId]);
}
