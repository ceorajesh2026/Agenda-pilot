// Settings screen: shows whether a Claude API key is configured (never displays the stored
// key) and lets the user paste + save a new one. The key powers AI drafting of change copy
// and file import. Null-safe against an offline backend.
import { useEffect, useState } from 'react';
import { getAnthropicKeyStatus, saveAnthropicKey, changePassword } from '../lib/api';

export default function Settings({ onBack, isAdmin = true }: { onBack: () => void; isAdmin?: boolean }) {
  const [present, setPresent] = useState<boolean | null>(null);
  const [offline, setOffline] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const load = () => {
    if (!isAdmin) return;
    getAnthropicKeyStatus().then((res) => {
      if (res && typeof res.present === 'boolean') { setPresent(res.present); setOffline(false); }
      else { setPresent(null); setOffline(true); }
    });
  };
  useEffect(load, [isAdmin]);

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
        <div className="sub">{isAdmin ? 'Settings' : 'My account'}</div>
        <div style={{ marginLeft: 'auto' }}>
          <button className="btn sm" onClick={onBack}>‹ All conferences</button>
        </div>
      </header>

      {isAdmin && (
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
      )}

      <ChangePasswordCard />
    </div>
  );
}

// Available to every signed-in user (admins and members alike).
function ChangePasswordCard() {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError(''); setDone(false);
    if (pw.length < 8) { setError('Please choose a password of at least 8 characters.'); return; }
    if (pw !== confirm) { setError("Those passwords don't match."); return; }
    setBusy(true);
    const res = await changePassword(pw);
    setBusy(false);
    if (res?.ok) { setDone(true); setPw(''); setConfirm(''); }
    else setError("Couldn't change your password — please try again.");
  };

  return (
    <div className="card" style={{ maxWidth: 620, marginTop: 16 }}>
      <div className="section-title" style={{ marginTop: 0 }}>Change my password</div>
      <div className="frow col"><label>New password</label>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)}
          autoComplete="new-password" placeholder="At least 8 characters" style={{ width: '100%' }} />
      </div>
      <div className="frow col"><label>Confirm new password</label>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password" placeholder="Type it again" style={{ width: '100%' }} />
      </div>
      {error && <div className="sc-body" style={{ color: 'var(--red)', marginBottom: 8 }}>{error}</div>}
      {done && <div className="sc-body" style={{ color: 'var(--green)', marginBottom: 8 }}>Your password has been changed.</div>}
      <div className="btnrow">
        <button className="btn ok" disabled={busy || !pw || !confirm} onClick={submit}>{busy ? 'Saving…' : 'Update password'}</button>
      </div>
    </div>
  );
}
