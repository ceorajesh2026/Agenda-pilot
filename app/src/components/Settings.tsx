// Settings screen: shows whether a Claude API key is configured (never displays the stored
// key) and lets the user paste + save a new one. The key powers AI drafting of change copy
// and file import. Null-safe against an offline backend.
import { useEffect, useState } from 'react';
import { getAnthropicKeyStatus, saveAnthropicKey } from '../lib/api';

export default function Settings({ onBack }: { onBack: () => void }) {
  const [present, setPresent] = useState<boolean | null>(null);
  const [offline, setOffline] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const load = () => {
    getAnthropicKeyStatus().then((res) => {
      if (res && typeof res.present === 'boolean') { setPresent(res.present); setOffline(false); }
      else { setPresent(null); setOffline(true); }
    });
  };
  useEffect(load, []);

  const save = async () => {
    if (!key.trim()) return;
    setBusy(true); setError(''); setSaved(false);
    const res = await saveAnthropicKey(key.trim());
    setBusy(false);
    if (res?.ok) { setSaved(true); setKey(''); setPresent(true); }
    else setError("Couldn't save the key — the server may be offline. Please try again.");
  };

  return (
    <div className="app">
      <header className="top">
        <h1>AgendaPilot</h1>
        <div className="sub">Settings</div>
        <div style={{ marginLeft: 'auto' }}>
          <button className="btn sm" onClick={onBack}>‹ All conferences</button>
        </div>
      </header>

      <div className="card" style={{ maxWidth: 620 }}>
        <div className="section-title" style={{ marginTop: 0 }}>Claude API key</div>

        {offline && (
          <div className="note">The server isn't reachable, so the key status can't be checked right now.</div>
        )}
        {!offline && present === true && (
          <div className="status-card green" style={{ margin: '0 0 12px' }}>
            <div className="sc-title">Connected ✓ — AI drafting and file import enabled</div>
            <div className="sc-body">A Claude API key is configured. You can replace it below at any time.</div>
          </div>
        )}
        {!offline && present === false && (
          <div className="status-card amber" style={{ margin: '0 0 12px' }}>
            <div className="sc-title">Not set</div>
            <div className="sc-body">Add a Claude API key to turn on AI features. Everything else works without it.</div>
          </div>
        )}

        <p className="sc-body" style={{ color: 'var(--muted)' }}>
          The key lets AgendaPilot use Claude to draft the rationale and the messages sent to
          affected people when you publish a schedule change, and to read uploaded agenda files.
          Without a key, the app falls back to clear ready-made wording — the disruption workflow
          still works end to end.
        </p>

        <div className="frow col" style={{ marginTop: 8 }}>
          <label>Paste your key</label>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-…" autoComplete="off" style={{ width: '100%' }} />
        </div>

        {error && <div className="sc-body" style={{ color: 'var(--red)', marginBottom: 8 }}>{error}</div>}
        {saved && <div className="sc-body" style={{ color: 'var(--green)', marginBottom: 8 }}>Saved. AI features are enabled.</div>}

        <div className="btnrow">
          <button className="btn ok" disabled={busy || !key.trim()} onClick={save}>{busy ? 'Saving…' : 'Save key'}</button>
        </div>
        <p className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          Your key is stored on the server and never shown back here.
        </p>
      </div>
    </div>
  );
}
