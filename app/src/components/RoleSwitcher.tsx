// Segmented control in the top bar: who is looking at the app right now.
export type AppRole = 'secretariat' | 'chair' | 'speaker' | 'attendee';

const ROLES: { id: AppRole; label: string }[] = [
  { id: 'secretariat', label: 'Secretariat' },
  { id: 'chair', label: 'Chair' },
  { id: 'speaker', label: 'Speaker' },
  { id: 'attendee', label: 'Attendee' },
];

export default function RoleSwitcher({ role, onChange }: { role: AppRole; onChange: (r: AppRole) => void }) {
  return (
    <div className="rolebar" role="tablist" aria-label="View as">
      {ROLES.map((r) => (
        <button key={r.id} role="tab" aria-selected={role === r.id}
          className={role === r.id ? 'active' : ''} onClick={() => onChange(r.id)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}
