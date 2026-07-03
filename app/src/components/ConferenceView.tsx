// A single conference: loads the /c/:id/agenda snapshot, builds the Agenda context, mounts
// the workflow provider, and renders the full existing app (role switcher + secretariat tabs
// + Chair/Speaker/Attendee views). Friendly loading + error/retry states while the snapshot
// is fetched. Degrades gracefully if the API is unreachable.
import { useEffect, useState } from 'react';
import { getAgenda } from '../lib/api';
import type { AgendaSnapshot } from '../lib/api';
import { AgendaProvider, buildAgenda } from '../lib/data';
import type { Agenda } from '../lib/data';
import { WorkflowProvider, useWorkflow } from '../lib/workflow';
import RoleSwitcher from './RoleSwitcher';
import type { AppRole } from './RoleSwitcher';
import Today from './secretariat/Today';
import Dashboard from './secretariat/Dashboard';
import AgendaView from './secretariat/AgendaView';
import Activity from './secretariat/Activity';
import ChairView from './ChairView';
import SpeakerView from './SpeakerView';
import AttendeeView from './AttendeeView';
import ImportWizard from './ImportWizard';

type SecTab = 'today' | 'dashboard' | 'agenda' | 'activity';
type LoadState = 'loading' | 'ready' | 'error';

function goImport(confId: string) { window.location.hash = `#/c/${encodeURIComponent(confId)}/import`; }
function goApp(confId: string) { window.location.hash = `#/c/${encodeURIComponent(confId)}`; }

export default function ConferenceView(
  { confId, onBack, view = 'app' }: { confId: string; onBack: () => void; view?: 'app' | 'import' },
) {
  const [state, setState] = useState<LoadState>('loading');
  const [agenda, setAgenda] = useState<Agenda | null>(null);
  // A conference that loaded fine but has no sessions/people yet — the setup entry point.
  const [empty, setEmpty] = useState(false);
  // When the organiser chooses "skip for now", drop into the normal (empty) app.
  const [skipEmpty, setSkipEmpty] = useState(false);

  const load = () => {
    setState('loading');
    setEmpty(false);
    getAgenda(confId).then((snap: AgendaSnapshot | null) => {
      if (!snap) {
        // Only a null snapshot means the backend is unreachable.
        setState('error');
        return;
      }
      const hasSessions = Array.isArray(snap.sessions) && snap.sessions.length > 0;
      const hasPeople = Array.isArray(snap.people) && snap.people.length > 0;
      setAgenda(buildAgenda(snap, confId));
      setEmpty(!hasSessions && !hasPeople);
      setState('ready');
    });
  };

  useEffect(load, [confId]);

  // Import wizard mode: render inside the conference context (needs confId + name + a way back).
  if (view === 'import') {
    const name = agenda?.seed.event.name ?? 'Conference';
    const hasSessions = (agenda?.seed.sessions.length ?? 0) > 0;
    return (
      <ImportWizard
        confId={confId}
        conferenceName={name}
        conferenceHasSessions={hasSessions}
        onBack={() => goApp(confId)}
        onDone={() => goApp(confId)}
      />
    );
  }

  if (state === 'loading') {
    return (
      <div className="app">
        <MiniHeader onBack={onBack} name="Loading…" />
        <div className="landing-empty">
          <div className="spinner" />
          <p className="muted">Loading the agenda…</p>
        </div>
      </div>
    );
  }

  if (state === 'error' || !agenda) {
    return (
      <div className="app">
        <MiniHeader onBack={onBack} name="Conference" />
        <div className="landing-empty">
          <div className="status-card amber" style={{ maxWidth: 520, margin: '0 auto', textAlign: 'left' }}>
            <div className="sc-title">Couldn't load this conference</div>
            <div className="sc-body">
              The agenda isn't reachable right now — the backend may still be starting up.
              Please try again in a moment.
            </div>
            <div className="btnrow" style={{ marginTop: 12 }}>
              <button className="btn ok" onClick={load}>Try again</button>
              <button className="btn" onClick={onBack}>‹ All conferences</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Friendly setup hero when the conference has no schedule yet (unless the user chose to skip).
  if (empty && !skipEmpty) {
    return (
      <div className="app">
        <MiniHeader onBack={onBack} name={agenda.seed.event.name} />
        <div className="landing-empty">
          <div className="setup-hero">
            <div className="setup-emoji">🗓️</div>
            <h2 className="setup-title">Let's build your schedule</h2>
            <p className="setup-lead">
              Upload your programme files — Excel, Word, PDF or CSV — and AI does the rest:
              it reads the days, halls, sessions and speakers so you don't have to type them in.
            </p>
            <div className="btnrow" style={{ justifyContent: 'center', marginTop: 8 }}>
              <button className="btn hero" onClick={() => goImport(confId)}>📂 Import programme files</button>
            </div>
            <button className="quiet-link" style={{ marginTop: 14, background: 'none', border: 'none', cursor: 'pointer' }}
              onClick={() => setSkipEmpty(true)}>
              Skip for now — I'll set it up manually
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <AgendaProvider agenda={agenda}>
      <WorkflowProvider confId={confId}>
        <Shell onBack={onBack} name={agenda.seed.event.name} confId={confId} />
      </WorkflowProvider>
    </AgendaProvider>
  );
}

function MiniHeader({ onBack, name }: { onBack: () => void; name: string }) {
  return (
    <header className="top">
      <button className="linkback" onClick={onBack} style={{ marginBottom: 0 }}>‹ All conferences</button>
      <h1 style={{ marginLeft: 4 }}>AgendaPilot</h1>
      <div className="sub">{name}</div>
    </header>
  );
}

function Shell({ onBack, name }: { onBack: () => void; name: string; confId: string }) {
  const [role, setRole] = useState<AppRole>('secretariat');
  const [tab, setTab] = useState<SecTab>('today');
  const wf = useWorkflow();

  const newReports = wf.reports.filter((r) => r.status === 'new').length;

  return (
    <div className="app">
      <header className="top">
        <button className="linkback" onClick={onBack} style={{ marginBottom: 0 }}>‹ All conferences</button>
        <h1 style={{ marginLeft: 4 }}>AgendaPilot</h1>
        <div className="sub">{name}</div>
        <div style={{ marginLeft: 'auto' }}>
          <RoleSwitcher role={role} onChange={setRole} />
        </div>
      </header>

      {role === 'secretariat' && (
        <>
          <nav className="tabs">
            <button className={tab === 'today' ? 'active' : ''} onClick={() => setTab('today')}>
              Today{newReports > 0 && <span className="count-dot">{newReports}</span>}
            </button>
            <button className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')}>Dashboard</button>
            <button className={tab === 'agenda' ? 'active' : ''} onClick={() => setTab('agenda')}>Agenda</button>
            <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Activity</button>
          </nav>
          {tab === 'today' && <Today />}
          {tab === 'dashboard' && <Dashboard />}
          {tab === 'agenda' && <AgendaView />}
          {tab === 'activity' && <Activity />}
        </>
      )}

      {role === 'chair' && <ChairView />}
      {role === 'speaker' && <SpeakerView />}
      {role === 'attendee' && <AttendeeView />}
    </div>
  );
}
