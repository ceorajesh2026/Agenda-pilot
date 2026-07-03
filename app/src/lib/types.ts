// Domain types — mirror the normalized schema emitted by etl/build_seed.py.
export type RoleType =
  | 'speaker' | 'moderator' | 'grand_master' | 'quiz_master'
  | 'session_expert' | 'panellist' | 'clinical_expert'
  | 'pathology_expert' | 'workshop_director';

export type MatchKind = 'exact' | 'fuzzy' | 'ambiguous' | 'unmatched' | 'group';
export type SessionState = 'DRAFT' | 'SCHEDULED' | 'PUBLISHED' | 'REVISED' | 'CANCELLED';

export interface Person {
  id: string;
  name: string;
  name_key: string;
  category: string;
  speciality: string;
  emails: string[];
  phones: string[];
  whatsapp_likely: boolean;
  designation: string;
  institution: string;
  city: string;
  country: string;
  status: string;
  commitment: string;
  segments: string[];
  declined: boolean;
  wrong_email: boolean;
  reachable_email: boolean;
  reachable_wa_sms: boolean;
}

export interface Hall { id: string; name: string; provisional: boolean; }
export interface Track { id: string; name: string; kind: string; status: string; }
export interface Day { date: string; label: string; }

export interface Session {
  id: string;
  title: string;
  type: 'session' | 'break';
  date: string | null;
  start_min: number | null;
  end_min: number | null;
  start: string | null;
  end: string | null;
  track: string;
  stream: string;
  state: SessionState;
  locked: boolean;
  hall_id: string;
  band?: string | null;
}

export interface Slot {
  id: string;
  session_id: string;
  title: string;
  duration_min: number | null;
  kind: 'talk' | 'qa';
  order: number;
}

export interface Role {
  id: string;
  session_id: string;
  slot_id: string | null;
  role_type: RoleType;
  name_raw: string;
  person_id: string | null;
  match: MatchKind;
}

export interface Seed {
  event: { id: string; name: string; start_date: string; end_date: string; website: string };
  generated_note: string;
  tracks: Track[];
  days: Day[];
  halls: Hall[];
  people: Person[];
  sessions: Session[];
  slots: Slot[];
  roles: Role[];
  resolution_review: { raw: string; key: string; result: string; score: string }[];
  resolution_stats: Record<string, number>;
}
