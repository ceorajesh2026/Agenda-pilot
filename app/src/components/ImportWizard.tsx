// Import wizard (Phase B). Three steps shown as a rail:
//   1. Upload    — drag/drop or pick programme files, push each to signed storage.
//   2. Process   — run Claude parsing per file, sequentially, with live status.
//   3. Review    — show the resulting draft (stats + flags + preview) and commit or discard.
// Every network call is null-safe (mirrors lib/api.ts): the wizard degrades to plain,
// friendly messages when the backend is unreachable rather than throwing.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getProseHealth, signUpload, putSignedFile, completeUpload, listUploads,
  processUpload, getImportDraft, commitImport, discardImport,
} from '../lib/api';
import type { UploadRow, ImportDraft, ImportSummary } from '../lib/api';

const ACCEPT = '.xlsx,.xls,.docx,.csv,.pdf,.txt';
const ACCEPT_EXT = ['xlsx', 'xls', 'docx', 'csv', 'pdf', 'txt'];

type Step = 'upload' | 'process' | 'review';

// A locally-selected file plus its upload lifecycle.
type UpStatus = 'ready' | 'uploading' | 'uploaded' | 'failed';
interface LocalFile {
  key: string;
  file: File;
  status: UpStatus;
  uploadId?: string;
}

// Per-file processing status in step 2.
type ProcStatus = 'pending' | 'working' | 'done' | 'failed';
interface ProcRow {
  uploadId: string;
  filename: string;
  status: ProcStatus;
  message?: string;
}

function fmtSize(bytes: number): string {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extOk(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ACCEPT_EXT.includes(ext);
}

function mimeFor(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    csv: 'text/csv', pdf: 'application/pdf', txt: 'text/plain',
  };
  return map[ext] ?? 'application/octet-stream';
}

export default function ImportWizard(props: {
  confId: string;
  conferenceName: string;
  conferenceHasSessions: boolean;
  onBack: () => void;
  onDone: () => void;
}) {
  const { confId, conferenceName, conferenceHasSessions, onBack, onDone } = props;

  const [step, setStep] = useState<Step>('upload');

  // Claude availability check (amber note if missing).
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    getProseHealth().then((h) => setAiAvailable(h ? !!h.available : null));
  }, []);

  // ---- step 1: uploads ----
  const [local, setLocal] = useState<LocalFile[]>([]);
  const [serverUploads, setServerUploads] = useState<UploadRow[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refreshUploads = () => {
    listUploads(confId).then((res) => {
      if (res && Array.isArray(res.uploads)) setServerUploads(res.uploads);
    });
  };
  useEffect(refreshUploads, [confId]);

  const addFiles = (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => extOk(f.name));
    if (!arr.length) return;
    setLocal((prev) => [
      ...prev,
      ...arr.map((file) => ({ key: `${file.name}:${file.size}:${Math.random().toString(36).slice(2)}`, file, status: 'ready' as UpStatus })),
    ]);
  };

  const uploadOne = async (lf: LocalFile) => {
    setLocal((prev) => prev.map((x) => (x.key === lf.key ? { ...x, status: 'uploading' } : x)));
    const mime = mimeFor(lf.file);
    const signed = await signUpload(confId, { filename: lf.file.name, mime, size: lf.file.size });
    if (!signed?.signedUrl || !signed.uploadId) {
      setLocal((prev) => prev.map((x) => (x.key === lf.key ? { ...x, status: 'failed' } : x)));
      return;
    }
    const put = await putSignedFile(signed.signedUrl, mime, lf.file);
    if (!put) {
      setLocal((prev) => prev.map((x) => (x.key === lf.key ? { ...x, status: 'failed', uploadId: signed.uploadId } : x)));
      return;
    }
    const done = await completeUpload(confId, signed.uploadId);
    if (done?.ok) {
      setLocal((prev) => prev.map((x) => (x.key === lf.key ? { ...x, status: 'uploaded', uploadId: signed.uploadId } : x)));
      refreshUploads();
    } else {
      setLocal((prev) => prev.map((x) => (x.key === lf.key ? { ...x, status: 'failed', uploadId: signed.uploadId } : x)));
    }
  };

  const uploadAll = async () => {
    const pending = local.filter((x) => x.status === 'ready' || x.status === 'failed');
    for (const lf of pending) await uploadOne(lf);
  };

  // Which uploads are available to process: freshly-uploaded (this session) + previously stored.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const processableUploads = useMemo(() => {
    // De-dupe by upload id, preferring the server row (has a stable filename).
    const byId = new Map<string, { id: string; filename: string; size: number }>();
    for (const lf of local) {
      if (lf.status === 'uploaded' && lf.uploadId) {
        byId.set(lf.uploadId, { id: lf.uploadId, filename: lf.file.name, size: lf.file.size });
      }
    }
    for (const u of serverUploads) {
      if (u.status === 'failed') continue;
      byId.set(u.id, { id: u.id, filename: u.filename, size: u.size_bytes });
    }
    return [...byId.values()];
  }, [local, serverUploads]);

  // Default selection: everything processable, whenever the set changes.
  useEffect(() => {
    setSelectedIds(new Set(processableUploads.map((u) => u.id)));
  }, [processableUploads]);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const anyUploaded = processableUploads.length > 0;

  // ---- step 2: processing ----
  const [procRows, setProcRows] = useState<ProcRow[]>([]);
  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState('');

  const runProcessing = async () => {
    const toRun = processableUploads.filter((u) => selectedIds.has(u.id));
    if (!toRun.length) return;
    setProcessing(true);
    setProcessError('');
    setProcRows(toRun.map((u) => ({ uploadId: u.id, filename: u.filename, status: 'pending' as ProcStatus })));

    let hadNoKey = false;
    let prev: ImportSummary | null = null;
    for (const u of toRun) {
      setProcRows((rows) => rows.map((r) => (r.uploadId === u.id ? { ...r, status: 'working' } : r)));
      const res = await processUpload(confId, u.id);
      if (res.ok) {
        const s = res.summary;
        const msg = s ? summaryDelta(prev, s) : 'Processed';
        prev = s ?? prev;
        setProcRows((rows) => rows.map((r) => (r.uploadId === u.id ? { ...r, status: 'done', message: msg } : r)));
      } else {
        if (res.error === 'no_api_key') hadNoKey = true;
        const msg = res.error === 'no_api_key' ? 'Needs a Claude API key'
          : res.error === 'offline' ? "Couldn't reach the server — try again"
          : "Couldn't read this file";
        setProcRows((rows) => rows.map((r) => (r.uploadId === u.id ? { ...r, status: 'failed', message: msg } : r)));
      }
    }
    setProcessing(false);
    if (hadNoKey) setProcessError('no_api_key');
    // Move to review if anything succeeded.
    const draftRes = await getImportDraft(confId);
    if (draftRes?.draft) {
      setDraft(draftRes.draft);
      setStep('review');
    }
  };

  // ---- step 3: review ----
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);

  const loadDraft = () => {
    setDraftLoading(true);
    getImportDraft(confId).then((res) => {
      setDraft(res?.draft ?? null);
      setDraftLoading(false);
    });
  };
  useEffect(() => { if (step === 'review' && !draft) loadDraft(); }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const [mode, setMode] = useState<'replace' | 'append'>(conferenceHasSessions ? 'replace' : 'replace');
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<Record<string, number> | null>(null);
  const [commitFailed, setCommitFailed] = useState(false);

  const commit = async () => {
    setCommitting(true);
    setCommitFailed(false);
    const res = await commitImport(confId, mode);
    setCommitting(false);
    if (res?.ok) {
      setCommitted(res.counts ?? {});
      // Give the celebratory card a moment, then navigate (remounts + refetches the agenda).
      setTimeout(onDone, 1400);
    } else {
      setCommitFailed(true);
    }
  };

  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const discard = async () => {
    setDiscarding(true);
    await discardImport(confId);
    setDiscarding(false);
    setDraft(null);
    setConfirmDiscard(false);
    setStep('upload');
  };

  return (
    <div className="app">
      <header className="top">
        <button className="linkback" onClick={onBack} style={{ marginBottom: 0 }}>‹ Back to conference</button>
        <h1 style={{ marginLeft: 4 }}>AgendaPilot</h1>
        <div className="sub">Import programme · {conferenceName}</div>
      </header>

      <StepRail step={step} />

      {step === 'upload' && (
        <UploadStep
          aiAvailable={aiAvailable}
          local={local}
          setLocal={setLocal}
          serverUploads={serverUploads}
          processableUploads={processableUploads}
          selectedIds={selectedIds}
          toggleSelected={toggleSelected}
          dragOver={dragOver}
          setDragOver={setDragOver}
          inputRef={inputRef}
          addFiles={addFiles}
          uploadOne={uploadOne}
          uploadAll={uploadAll}
          anyUploaded={anyUploaded}
          onNext={() => setStep('process')}
        />
      )}

      {step === 'process' && (
        <ProcessStep
          processableUploads={processableUploads}
          selectedIds={selectedIds}
          toggleSelected={toggleSelected}
          procRows={procRows}
          processing={processing}
          processError={processError}
          runProcessing={runProcessing}
          onBack={() => setStep('upload')}
        />
      )}

      {step === 'review' && (
        <ReviewStep
          draft={draft}
          draftLoading={draftLoading}
          loadDraft={loadDraft}
          conferenceHasSessions={conferenceHasSessions}
          mode={mode}
          setMode={setMode}
          commit={commit}
          committing={committing}
          committed={committed}
          commitFailed={commitFailed}
          confirmDiscard={confirmDiscard}
          setConfirmDiscard={setConfirmDiscard}
          discard={discard}
          discarding={discarding}
          onBack={() => setStep('process')}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- step rail
function StepRail({ step }: { step: Step }) {
  const order: Step[] = ['upload', 'process', 'review'];
  const labels: Record<Step, string> = { upload: 'Upload files', process: 'AI processing', review: 'Review & commit' };
  const idx = order.indexOf(step);
  return (
    <div className="rail">
      {order.map((s, i) => {
        const cls = i < idx ? 'railstep done' : i === idx ? 'railstep active' : 'railstep';
        return (
          <div className={cls} key={s}>
            <span className="dotn">{i < idx ? '✓' : i + 1}</span>
            {labels[s]}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- step 1: upload
function UploadStep(props: {
  aiAvailable: boolean | null;
  local: LocalFile[];
  setLocal: React.Dispatch<React.SetStateAction<LocalFile[]>>;
  serverUploads: UploadRow[];
  processableUploads: { id: string; filename: string; size: number }[];
  selectedIds: Set<string>;
  toggleSelected: (id: string) => void;
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  addFiles: (files: FileList | File[]) => void;
  uploadOne: (lf: LocalFile) => void;
  uploadAll: () => void;
  anyUploaded: boolean;
  onNext: () => void;
}) {
  const {
    aiAvailable, local, setLocal, serverUploads, processableUploads, selectedIds, toggleSelected,
    dragOver, setDragOver, inputRef, addFiles, uploadOne, uploadAll, anyUploaded, onNext,
  } = props;

  const hasPending = local.some((x) => x.status === 'ready' || x.status === 'failed');
  // Previously-uploaded server rows that aren't from this session's local list.
  const localUploadIds = new Set(local.filter((x) => x.uploadId).map((x) => x.uploadId));
  const priorUploads = serverUploads.filter((u) => !localUploadIds.has(u.id));

  return (
    <>
      {aiAvailable === false && (
        <div className="status-card amber">
          <div className="sc-title">⚠ Add your Claude API key first</div>
          <div className="sc-body">
            AI processing reads your files with Claude, which needs an API key.{' '}
            <a href="#/settings">Add it in Settings</a>, then come back — you can still upload files now.
          </div>
        </div>
      )}

      <div className="section-title" style={{ marginTop: 12 }}>Choose your programme files</div>

      <div
        className={`dropzone${dragOver ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        <div className="dz-emoji">📂</div>
        <div className="dz-title">Drag &amp; drop your files here</div>
        <div className="dz-hint">or click to browse — Excel, Word, PDF, CSV or text. You can add several.</div>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
        />
      </div>

      {local.length > 0 && (
        <>
          <div className="section-title">Selected files</div>
          {local.map((lf) => (
            <div className="filerow" key={lf.key}>
              <span className="file-ico">📄</span>
              <div className="file-main">
                <div className="file-name">{lf.file.name}</div>
                <div className="file-sub">{fmtSize(lf.file.size)}</div>
              </div>
              <UpStatusChip status={lf.status} />
              {(lf.status === 'ready' || lf.status === 'failed') && (
                <button className="btn sm" onClick={() => uploadOne(lf)}>
                  {lf.status === 'failed' ? 'Retry' : 'Upload'}
                </button>
              )}
              {lf.status !== 'uploading' && (
                <button className="btn sm" onClick={() => setLocal((prev) => prev.filter((x) => x.key !== lf.key))}>Remove</button>
              )}
            </div>
          ))}
          {hasPending && (
            <div className="btnrow" style={{ marginTop: 10 }}>
              <button className="btn ok" onClick={uploadAll}>⬆ Upload all</button>
            </div>
          )}
        </>
      )}

      {priorUploads.length > 0 && (
        <>
          <div className="section-title">Already uploaded</div>
          <div className="sc-body muted" style={{ marginBottom: 8 }}>
            Tick the files you want the AI to read in the next step.
          </div>
          {priorUploads.map((u) => (
            <label className="filerow selectable" key={u.id}>
              <input type="checkbox" checked={selectedIds.has(u.id)} onChange={() => toggleSelected(u.id)} />
              <span className="file-ico">📄</span>
              <div className="file-main">
                <div className="file-name">{u.filename}</div>
                <div className="file-sub">{fmtSize(u.size_bytes)}</div>
              </div>
              <span className="chip published">✓ stored</span>
            </label>
          ))}
        </>
      )}

      <div className="btnrow" style={{ marginTop: 20 }}>
        <button className="btn ok" disabled={!anyUploaded} onClick={onNext}>
          Next: process with AI →
        </button>
      </div>
      {!anyUploaded && processableUploads.length === 0 && (
        <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          Upload at least one file to continue.
        </p>
      )}
    </>
  );
}

function UpStatusChip({ status }: { status: UpStatus }) {
  if (status === 'uploading') return <span className="chip info">Uploading…</span>;
  if (status === 'uploaded') return <span className="chip published">✓ Uploaded</span>;
  if (status === 'failed') return <span className="chip error">✗ Failed</span>;
  return <span className="chip track">Ready</span>;
}

// ---------------------------------------------------------------- step 2: process
function ProcessStep(props: {
  processableUploads: { id: string; filename: string; size: number }[];
  selectedIds: Set<string>;
  toggleSelected: (id: string) => void;
  procRows: ProcRow[];
  processing: boolean;
  processError: string;
  runProcessing: () => void;
  onBack: () => void;
}) {
  const { processableUploads, selectedIds, toggleSelected, procRows, processing, processError, runProcessing, onBack } = props;
  const selectedCount = processableUploads.filter((u) => selectedIds.has(u.id)).length;
  const started = procRows.length > 0;

  return (
    <>
      <div className="section-title" style={{ marginTop: 12 }}>Files to read</div>

      {processError === 'no_api_key' && (
        <div className="status-card amber">
          <div className="sc-title">⚠ Claude API key needed</div>
          <div className="sc-body">The server has no Claude API key set. <a href="#/settings">Add it in Settings</a>, then try again.</div>
        </div>
      )}

      {!started && (
        <>
          {processableUploads.map((u) => (
            <label className="filerow selectable" key={u.id}>
              <input type="checkbox" checked={selectedIds.has(u.id)} onChange={() => toggleSelected(u.id)} />
              <span className="file-ico">📄</span>
              <div className="file-main"><div className="file-name">{u.filename}</div><div className="file-sub">{fmtSize(u.size)}</div></div>
            </label>
          ))}
          {processableUploads.length === 0 && <p className="muted">No uploaded files to process yet. Go back and upload some.</p>}
        </>
      )}

      {started && (
        <div style={{ marginTop: 4 }}>
          {procRows.map((r) => (
            <div className="filerow" key={r.uploadId}>
              {r.status === 'working' ? <span className="spinner sm" /> : <span className="file-ico">{r.status === 'done' ? '✅' : r.status === 'failed' ? '⚠️' : '📄'}</span>}
              <div className="file-main">
                <div className="file-name">
                  {r.status === 'working' ? `Reading ${r.filename} — this takes a minute or two…` : r.filename}
                </div>
                {r.message && <div className="file-sub">{r.message}</div>}
              </div>
              <ProcStatusChip status={r.status} />
            </div>
          ))}
        </div>
      )}

      <div className="btnrow" style={{ marginTop: 20 }}>
        {!started && (
          <button className="btn hero" disabled={processing || selectedCount === 0} onClick={runProcessing}>
            🤖 Process with AI{selectedCount > 0 ? ` (${selectedCount})` : ''}
          </button>
        )}
        {started && !processing && (
          <button className="btn ok" onClick={runProcessing}>Run again</button>
        )}
        <button className="btn" disabled={processing} onClick={onBack}>‹ Back to upload</button>
      </div>

      {processing && (
        <p className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
          Please keep this tab open — reading each file takes a minute or two.
        </p>
      )}
    </>
  );
}

function ProcStatusChip({ status }: { status: ProcStatus }) {
  if (status === 'working') return <span className="chip info">Working…</span>;
  if (status === 'done') return <span className="chip published">✓ Done</span>;
  if (status === 'failed') return <span className="chip error">✗ Failed</span>;
  return <span className="chip track">Waiting</span>;
}

// ---------------------------------------------------------------- step 3: review
function ReviewStep(props: {
  draft: ImportDraft | null;
  draftLoading: boolean;
  loadDraft: () => void;
  conferenceHasSessions: boolean;
  mode: 'replace' | 'append';
  setMode: (m: 'replace' | 'append') => void;
  commit: () => void;
  committing: boolean;
  committed: Record<string, number> | null;
  commitFailed: boolean;
  confirmDiscard: boolean;
  setConfirmDiscard: (v: boolean) => void;
  discard: () => void;
  discarding: boolean;
  onBack: () => void;
}) {
  const {
    draft, draftLoading, loadDraft, conferenceHasSessions, mode, setMode, commit, committing,
    committed, commitFailed, confirmDiscard, setConfirmDiscard, discard, discarding, onBack,
  } = props;

  if (committed) {
    const total = Object.values(committed).reduce((a, b) => a + b, 0);
    return (
      <div className="status-card green" style={{ marginTop: 16 }}>
        <div className="sc-title">🎉 Your schedule is built!</div>
        <div className="sc-body">
          {total > 0
            ? 'Everything from your files is now in the agenda. Taking you there…'
            : 'The import is committed. Taking you to your agenda…'}
        </div>
      </div>
    );
  }

  if (draftLoading) {
    return <div className="landing-empty"><div className="spinner" /><p className="muted">Loading the draft…</p></div>;
  }

  if (!draft) {
    return (
      <div className="status-card amber" style={{ marginTop: 16 }}>
        <div className="sc-title">Nothing to review yet</div>
        <div className="sc-body">We couldn't find a processed draft. Go back and run the AI step, or try reloading.</div>
        <div className="btnrow" style={{ marginTop: 10 }}>
          <button className="btn ok" onClick={loadDraft}>Reload</button>
          <button className="btn" onClick={onBack}>‹ Back</button>
        </div>
      </div>
    );
  }

  const s = draft.summary;
  const matchedTxt = `${s.resolvedRoles ?? 0} of ${(s.resolvedRoles ?? 0) + (s.unresolvedRoles ?? 0)}`;

  return (
    <>
      <div className="section-title" style={{ marginTop: 12 }}>What we found</div>
      {s.files && s.files.length > 0 && (
        <p className="muted" style={{ marginTop: -4, marginBottom: 10, fontSize: 12.5 }}>
          From {s.files.join(', ')}
        </p>
      )}

      <div className="grid cards">
        <StatCard label="Days" value={s.days} />
        <StatCard label="Halls" value={s.halls} />
        <StatCard label="Sessions" value={s.sessions} />
        <StatCard label="Talks" value={s.slots} />
        <StatCard label="People" value={s.people} />
        <StatCard label="Speakers matched" value={matchedTxt} hint="matched to a contact" />
      </div>

      {s.flags && s.flags.length > 0 && (
        <>
          <div className="section-title">Worth a look before you commit</div>
          {s.flags.map((f, i) => (
            <div className="finding warning" key={i}>
              <div className="body"><div className="fdetail" style={{ fontSize: 13, color: 'var(--text)' }}>{f}</div></div>
            </div>
          ))}
        </>
      )}

      <DraftPreview draft={draft} />

      <div className="section-title">Add it to your conference</div>

      {conferenceHasSessions ? (
        <div className="card" style={{ maxWidth: 640 }}>
          <label className={`radio-opt${mode === 'replace' ? ' active' : ''}`} style={{ display: 'flex', marginBottom: 8 }}>
            <input type="radio" name="commitmode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
            <span style={{ marginLeft: 8 }}>Replace current schedule</span>
          </label>
          <label className={`radio-opt${mode === 'append' ? ' active' : ''}`} style={{ display: 'flex' }}>
            <input type="radio" name="commitmode" checked={mode === 'append'} onChange={() => setMode('append')} />
            <span style={{ marginLeft: 8 }}>Add to current schedule</span>
          </label>
          {mode === 'replace' && (
            <div className="status-card" style={{ borderColor: 'rgba(220,38,38,.4)', background: 'rgba(220,38,38,.05)', marginTop: 12 }}>
              <div className="sc-title" style={{ color: 'var(--red)' }}>⚠ This clears the existing schedule</div>
              <div className="sc-body">Replacing removes the current sessions and their activity history. This can't be undone.</div>
            </div>
          )}
          <div className="btnrow" style={{ marginTop: 14 }}>
            <button className="btn ok" disabled={committing} onClick={commit}>
              {committing ? 'Building…' : mode === 'replace' ? '✓ Replace schedule' : '✓ Add to schedule'}
            </button>
          </div>
        </div>
      ) : (
        <div className="btnrow">
          <button className="btn hero" disabled={committing} onClick={commit}>
            {committing ? 'Building…' : '✓ Build my schedule'}
          </button>
        </div>
      )}

      {commitFailed && (
        <div className="sc-body" style={{ color: 'var(--red)', marginTop: 10 }}>
          Couldn't commit right now — the server may be offline. Your draft is safe; please try again.
        </div>
      )}

      <div className="section-title">Not right?</div>
      {confirmDiscard ? (
        <div className="status-card amber">
          <div className="sc-title">Discard this draft?</div>
          <div className="sc-body">The uploaded files stay, but the parsed draft is thrown away. You can process again anytime.</div>
          <div className="btnrow" style={{ marginTop: 10 }}>
            <button className="btn bad" disabled={discarding} onClick={discard}>{discarding ? 'Discarding…' : 'Yes, discard'}</button>
            <button className="btn" disabled={discarding} onClick={() => setConfirmDiscard(false)}>Keep it</button>
          </div>
        </div>
      ) : (
        <div className="btnrow">
          <button className="btn" onClick={() => setConfirmDiscard(true)}>Discard draft</button>
          <button className="btn" onClick={onBack}>‹ Back</button>
        </div>
      )}
    </>
  );
}

function StatCard({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="big">{value ?? 0}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

// Expandable preview: sessions grouped by day + a people sample.
function DraftPreview({ draft }: { draft: ImportDraft }) {
  const data = draft.data ?? {};
  const sessions = data.sessions ?? [];
  const people = data.people ?? [];
  const days = data.days ?? [];

  const dayLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of days) m.set(d.date, d.label || d.date);
    return m;
  }, [days]);

  const byDay = useMemo(() => {
    const groups = new Map<string, typeof sessions>();
    for (const s of sessions) {
      const k = s.date ?? '—';
      const arr = groups.get(k) ?? [];
      arr.push(s);
      groups.set(k, arr);
    }
    for (const arr of groups.values()) {
      arr.sort((a, b) => (a.start_min ?? 1e9) - (b.start_min ?? 1e9));
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [sessions]);

  // Map role name(s) onto each session for a friendly one-line speaker list.
  const roles = data.roles ?? [];
  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const speakersBySession = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of roles) {
      const name = r.person_id ? (peopleById.get(r.person_id) ?? r.name_raw) : r.name_raw;
      if (!name) continue;
      const arr = m.get(r.session_id) ?? [];
      if (!arr.includes(name)) arr.push(name);
      m.set(r.session_id, arr);
    }
    return m;
  }, [roles, peopleById]);

  if (!sessions.length && !people.length) return null;

  return (
    <details className="problems" style={{ marginTop: 16 }}>
      <summary>Preview the schedule ({sessions.length} sessions, {people.length} people)</summary>

      {byDay.map(([date, list]) => (
        <div key={date} style={{ marginTop: 12 }}>
          <div className="section-title" style={{ margin: '4px 0 8px' }}>
            {date === '—' ? 'Day to be scheduled' : (dayLabel.get(date) ?? date)}
          </div>
          {list.map((s) => {
            const spk = speakersBySession.get(s.id) ?? [];
            return (
              <div className="session" key={s.id}>
                <div className="shead">
                  {s.start
                    ? <span className="stime">{s.start}{s.end ? `–${s.end}` : ''}</span>
                    : <span className="chip warning">no time yet</span>}
                  <span className="stitle">{s.title || 'Untitled session'}</span>
                </div>
                {spk.length > 0 && <div className="meta">{spk.join(', ')}</div>}
              </div>
            );
          })}
        </div>
      ))}

      {people.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="section-title" style={{ margin: '4px 0 8px' }}>People (sample)</div>
          <div className="btnrow">
            {people.slice(0, 10).map((p) => <span className="chip info" key={p.id}>{p.name}</span>)}
          </div>
          {people.length > 10 && (
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>…and {people.length - 10} more.</p>
          )}
        </div>
      )}
    </details>
  );
}

// Human "delta" line from one file's summary vs. the previous cumulative summary.
function summaryDelta(prev: ImportSummary | null, cur: ImportSummary): string {
  const dSessions = cur.sessions - (prev?.sessions ?? 0);
  const dPeople = cur.people - (prev?.people ?? 0);
  const sessions = dSessions > 0 ? dSessions : cur.sessions;
  const ppl = dPeople > 0 ? dPeople : cur.people;
  const parts: string[] = [];
  if (sessions) parts.push(`${sessions} session${sessions === 1 ? '' : 's'}`);
  if (ppl) parts.push(`${ppl} ${ppl === 1 ? 'person' : 'people'}`);
  return parts.length ? `✓ ${parts.join(', ')} found` : '✓ Processed';
}
