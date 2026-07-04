// Settings screen: shows whether a Claude API key is configured (never displays the stored
// key) and lets the user paste + save a new one. The key powers AI drafting of change copy
// and file import. Null-safe against an offline backend.
import { useEffect, useState } from 'react';
import { getAnthropicKeyStatus, saveAnthropicKey, changePassword, getEmailSettings, saveEmailSettings } from '../lib/api';
import type { EmailMode, EmailSettings } from '../lib/api';

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

      {isAdmin && <EmailDeliveryCard />}

      <ChangePasswordCard />
    </div>
  );
}

// Email delivery: controls whether published notifications are simulated, sent to a single
// test inbox, or sent for real. Admin-only. Null-safe against an offline backend. The Resend
// API key is write-only — we only ever learn whether one is present, never its value.
function EmailDeliveryCard() {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [offline, setOffline] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [apiKey, setApiKey] = useState('');
  const [from, setFrom] = useState('');
  const [mode, setMode] = useState<EmailMode>('simulate');
  const [testAddress, setTestAddress] = useState('');

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const load = () => {
    getEmailSettings().then((res) => {
      setLoaded(true);
      if (res && typeof res.key_present === 'boolean') {
        setSettings(res);
        setOffline(false);
        setFrom(res.from ?? '');
        setMode(res.mode ?? 'simulate');
        setTestAddress(res.test_address ?? '');
      } else {
        setSettings(null);
        setOffline(true);
      }
    });
  };
  useEffect(load, []);

  const keyPresent = settings?.key_present || !!apiKey.trim();

  const save = async () => {
    setBusy(true); setError(''); setSaved(false);
    const body: { api_key?: string; from?: string; mode?: EmailMode; test_address?: string } = {
      from: from.trim(),
      mode,
      test_address: testAddress.trim(),
    };
    if (apiKey.trim()) body.api_key = apiKey.trim();
    const res = await saveEmailSettings(body);
    setBusy(false);
    if (res.ok) {
      setSaved(true);
      setApiKey('');
      // reflect the newly-saved state locally so the headline updates without a reload
      setSettings((prev) => ({
        key_present: prev?.key_present || !!body.api_key,
        from: from.trim(),
        mode,
        test_address: testAddress.trim(),
      }));
    } else {
      setError(res.error);
    }
  };

  // Status headline reflects the SAVED state (not the unsaved form edits).
  const headline = (() => {
    if (!settings) return null;
    if (!settings.key_present) {
      return (
        <div className="status-card amber" style={{ margin: '0 0 12px' }}>
          <div className="sc-title">Not connected — emails are simulated (shown in Activity, not sent)</div>
          <div className="sc-body">Add a Resend API key below to start sending emails for real.</div>
        </div>
      );
    }
    if (settings.mode === 'test') {
      return (
        <div className="status-card blue" style={{ margin: '0 0 12px' }}>
          <div className="sc-title">Test mode — every email goes only to {settings.test_address || 'your test address'}</div>
          <div className="sc-body">Real recipients are never contacted while you're testing.</div>
        </div>
      );
    }
    if (settings.mode === 'live') {
      return (
        <div className="status-card red" style={{ margin: '0 0 12px' }}>
          <div className="sc-title">⚠ LIVE — emails go to real recipients</div>
          <div className="sc-body">Published changes will email real faculty addresses.</div>
        </div>
      );
    }
    return (
      <div className="status-card amber" style={{ margin: '0 0 12px' }}>
        <div className="sc-title">Simulated — emails are shown in Activity, not sent</div>
        <div className="sc-body">Switch to Test or Live below to start sending.</div>
      </div>
    );
  })();

  return (
    <div className="card" style={{ maxWidth: 620, marginTop: 16 }}>
      <div className="section-title" style={{ marginTop: 0 }}>Email delivery</div>

      {offline && (
        <div className="note">The server isn't reachable, so the email settings can't be checked right now.</div>
      )}

      {loaded && !offline && (
        <>
          {headline}

          <div className="frow col">
            <label>Resend API key</label>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder="re_…" autoComplete="off" style={{ width: '100%' }} />
            <span className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
              {settings?.key_present ? 'A key is saved. Paste a new one to replace it. ' : ''}
              Create a free key at <a href="https://resend.com" target="_blank" rel="noreferrer">resend.com</a>.
            </span>
          </div>

          <div className="frow col" style={{ marginTop: 10 }}>
            <label>From address</label>
            <input type="text" value={from} onChange={(e) => setFrom(e.target.value)}
              placeholder="WNS 2026 &lt;agenda@yourdomain.com&gt;" style={{ width: '100%' }} />
            <span className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
              The domain must be verified in Resend before emails will send.
            </span>
          </div>

          <div className="frow col" style={{ marginTop: 14 }}>
            <label>Mode</label>

            <label className="email-mode-row">
              <input type="radio" name="email-mode" checked={mode === 'simulate'}
                onChange={() => setMode('simulate')} />
              <span><strong>Simulate</strong> <span className="muted">(default, safe)</span> — emails are shown in Activity but never sent.</span>
            </label>

            <label className="email-mode-row">
              <input type="radio" name="email-mode" checked={mode === 'test'}
                onChange={() => setMode('test')} />
              <span><strong>Test</strong> — every email goes only to a single test inbox.</span>
            </label>
            {mode === 'test' && (
              <div className="frow col" style={{ margin: '2px 0 4px 26px' }}>
                <input type="email" value={testAddress} onChange={(e) => setTestAddress(e.target.value)}
                  placeholder="you@example.com" autoComplete="off" style={{ width: '100%', maxWidth: 320 }} />
              </div>
            )}

            <label className="email-mode-row">
              <input type="radio" name="email-mode" checked={mode === 'live'}
                onChange={() => setMode('live')} />
              <span><strong>Live</strong> — emails go to real recipients.</span>
            </label>
            {mode === 'live' && (
              <div className="sc-body" style={{ color: 'var(--red)', margin: '2px 0 4px 26px', fontWeight: 600 }}>
                Emails will be sent to real faculty addresses. Use only when you mean it.
              </div>
            )}
          </div>

          {mode === 'live' && !keyPresent && (
            <div className="sc-body" style={{ color: 'var(--amber)', marginTop: 8 }}>
              Live mode needs a Resend API key — add one above first.
            </div>
          )}

          {error && <div className="sc-body" style={{ color: 'var(--red)', marginTop: 8 }}>{error}</div>}
          {saved && <div className="sc-body" style={{ color: 'var(--green)', marginTop: 8 }}>Email settings saved.</div>}

          <div className="btnrow" style={{ marginTop: 12 }}>
            <button className="btn ok" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save email settings'}</button>
          </div>
        </>
      )}
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
