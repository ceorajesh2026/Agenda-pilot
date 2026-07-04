// App shell + tiny hash router (no router library). Routes:
//   #/login          → Login (also the default whenever there is no session)
//   #/               → Landing (conference picker — filtered to the user's conferences)
//   #/settings       → Settings (full for admins; password-only for everyone else)
//   #/admin          → AdminDash "Team & access" (admin only)
//   #/c/:id          → ConferenceView (role-locked to the user's membership)
//   #/c/:id/import   → ConferenceView in import-wizard mode
import { useEffect, useState } from 'react';
import Landing from './components/Landing';
import Settings from './components/Settings';
import ConferenceView from './components/ConferenceView';
import Login from './components/Login';
import AdminDash from './components/AdminDash';
import { useAuth } from './lib/auth';

type Route =
  | { name: 'landing' }
  | { name: 'settings' }
  | { name: 'admin' }
  | { name: 'login' }
  | { name: 'conference'; id: string; view: 'app' | 'import' };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#/, '');
  if (h === '/login') return { name: 'login' };
  if (h === '/settings') return { name: 'settings' };
  if (h === '/admin') return { name: 'admin' };
  const m = h.match(/^\/c\/([^/]+)(?:\/([^/]+))?/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const view = m[2] === 'import' ? 'import' : 'app';
    return { name: 'conference', id, view };
  }
  return { name: 'landing' };
}

function navigate(hash: string) {
  if (window.location.hash === hash) {
    // force a re-read even if the hash is unchanged
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = hash;
  }
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const { me, loading } = useAuth();

  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  // Booting the session (validating a stored token) — hold with a light splash so we don't
  // flash the login screen at an already-signed-in user.
  if (loading) {
    return (
      <div className="app">
        <div className="landing-empty">
          <div className="spinner" />
          <p className="muted">Loading…</p>
        </div>
      </div>
    );
  }

  // No session → the login screen is the whole app, for every route.
  if (!me) {
    return <Login />;
  }

  const isAdmin = !!me.user.is_admin;

  if (route.name === 'login') {
    // Already signed in — send them home.
    navigate('#/');
    return null;
  }

  if (route.name === 'admin') {
    if (!isAdmin) { navigate('#/'); return null; }
    return <AdminDash onBack={() => navigate('#/')} />;
  }

  if (route.name === 'settings') {
    return <Settings onBack={() => navigate('#/')} isAdmin={isAdmin} />;
  }

  if (route.name === 'conference') {
    return (
      <ConferenceView
        key={`${route.id}:${route.view}`}
        confId={route.id}
        view={route.view}
        onBack={() => navigate('#/')}
      />
    );
  }

  return (
    <Landing
      onOpen={(id) => navigate(`#/c/${encodeURIComponent(id)}`)}
      onSettings={() => navigate('#/settings')}
      onAdmin={() => navigate('#/admin')}
    />
  );
}
