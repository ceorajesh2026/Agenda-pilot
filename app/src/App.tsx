// App shell + tiny hash router (no router library). Routes:
//   #/               → Landing (conference picker)
//   #/settings       → Settings (Claude API key)
//   #/c/:id          → ConferenceView (the full existing app for one conference)
//   #/c/:id/import   → ConferenceView in import-wizard mode
import { useEffect, useState } from 'react';
import Landing from './components/Landing';
import Settings from './components/Settings';
import ConferenceView from './components/ConferenceView';

type Route =
  | { name: 'landing' }
  | { name: 'settings' }
  | { name: 'conference'; id: string; view: 'app' | 'import' };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#/, '');
  if (h === '/settings') return { name: 'settings' };
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

  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  if (route.name === 'settings') {
    return <Settings onBack={() => navigate('#/')} />;
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
    />
  );
}
