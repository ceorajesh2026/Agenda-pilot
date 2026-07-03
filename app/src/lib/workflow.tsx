// App-level shared workflow state, scoped to one conference. Mounted inside AgendaProvider
// so it survives role switching — this is what makes the two-step approval real: the
// Secretariat sends a proposal, the user switches to the Chair view to approve, then back
// to publish.
//
// Reports and the in-flight `flow` are persisted on the server (per conference) so they
// survive reloads and are shared across role views. Every server call is null-safe: if the
// backend is unreachable the provider keeps working in memory, exactly like before.
import { createContext, useContext, useEffect, useReducer, useRef } from 'react';
import type { ReactNode } from 'react';
import { useAgenda } from './data';
import { generateOptions } from './agent';
import type { Disruption, AgentOption, DraftNotification } from './agent';
import { enhanceProse } from './prose';
import { publishRevision } from './publish';
import type { PublishResult } from './publish';
import { getReports, postReport, setReportStatus, getFlowState, setFlowState } from './server';

// ---- report from a speaker (or logged by the secretariat) ----
export interface SpeakerReport {
  id: string;
  personId: string;
  kind: 'delay' | 'cancel';
  etaMin: number | null;
  reason: string;
  at: string;               // ISO timestamp
  source: 'speaker' | 'secretariat';
  status: 'new' | 'handling' | 'resolved';
}

export type FlowStage = 'options' | 'chair' | 'secretariat' | 'published' | 'rolledback';

export interface AuditEntry { at: string; actor: string; text: string; }

export interface Flow {
  disruption: Disruption;
  options: AgentOption[];
  chosen?: AgentOption;
  stage: FlowStage;
  notifications: DraftNotification[];
  distribution?: PublishResult | null;
  pdfUrl?: string | null;
  audit: AuditEntry[];
  reportId?: string;        // links the flow back to the report it resolves
}

interface WState {
  reports: SpeakerReport[];
  flow?: Flow;
}

const CHAIR = 'Neurology Scientific Chair';
const SEC = 'Secretariat';

// ---- helpers ----
function nowHM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function nowISO(): string { return new Date().toISOString(); }
function nowMin(): number { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function log(actor: string, text: string): AuditEntry { return { at: nowHM(), actor, text }; }

// ---- actions ----
type Action =
  | { t: 'setReports'; reports: SpeakerReport[] }
  | { t: 'submitReport'; report: SpeakerReport }
  | { t: 'startHandling'; reportId: string; disruption: Disruption; options: AgentOption[]; who: string; etaText: string }
  | { t: 'directFlow'; disruption: Disruption; options: AgentOption[]; who: string; etaText: string }
  | { t: 'choose'; opt: AgentOption }
  | { t: 'chairApprove'; edited?: boolean }
  | { t: 'chairReject'; note: string }
  | { t: 'sendBack' }
  | { t: 'publish'; dist: PublishResult | null; pdfUrl: string | null }
  | { t: 'ack'; idx: number }
  | { t: 'rollback' }
  | { t: 'resetFlow' }
  | { t: 'restoreFlow'; flow: Flow | undefined };

function reducer(s: WState, a: Action): WState {
  switch (a.t) {
    case 'setReports':
      return { ...s, reports: a.reports };

    case 'restoreFlow':
      return { ...s, flow: a.flow };

    case 'submitReport':
      return { ...s, reports: [a.report, ...s.reports] };

    case 'startHandling': {
      const valid = a.options.filter((o) => o.valid).length;
      const flow: Flow = {
        disruption: a.disruption, options: a.options, stage: 'options',
        notifications: [], audit: [
          log(a.who, a.disruption.kind === 'cancel'
            ? `Reported a cancellation — "${a.disruption.reason}"`
            : `Reported a delay (new ETA ${a.etaText}) — "${a.disruption.reason}"`),
          log('AgendaPilot', `Worked out who and what is affected, and prepared ${valid} option${valid === 1 ? '' : 's'} that keep the day running smoothly.`),
        ], reportId: a.reportId,
      };
      return {
        ...s,
        reports: s.reports.map((r) => (r.id === a.reportId ? { ...r, status: 'handling' } : r)),
        flow,
      };
    }

    case 'directFlow': {
      const valid = a.options.filter((o) => o.valid).length;
      const flow: Flow = {
        disruption: a.disruption, options: a.options, stage: 'options',
        notifications: [], audit: [
          log(SEC, a.disruption.kind === 'cancel'
            ? `Logged a cancellation for ${a.who} — "${a.disruption.reason}"`
            : `Logged a delay for ${a.who} (new ETA ${a.etaText}) — "${a.disruption.reason}"`),
          log('AgendaPilot', `Worked out who and what is affected, and prepared ${valid} option${valid === 1 ? '' : 's'} that keep the day running smoothly.`),
        ],
      };
      return { ...s, flow };
    }

    case 'choose': {
      if (!s.flow) return s;
      return { ...s, flow: { ...s.flow, stage: 'chair', chosen: a.opt,
        audit: [...s.flow.audit, log(SEC, `Chose "${a.opt.title}" and sent it to the ${CHAIR} for approval.`)] } };
    }

    case 'chairApprove': {
      if (!s.flow) return s;
      return { ...s, flow: { ...s.flow, stage: 'secretariat',
        audit: [...s.flow.audit, log(CHAIR, a.edited ? 'Approved with edits.' : 'Approved.')] } };
    }

    case 'chairReject': {
      if (!s.flow) return s;
      return { ...s, flow: { ...s.flow, stage: 'options', chosen: undefined,
        audit: [...s.flow.audit, log(CHAIR, `Sent back: "${a.note}". Please pick another option.`)] } };
    }

    case 'sendBack': {
      if (!s.flow) return s;
      return { ...s, flow: { ...s.flow, stage: 'chair',
        audit: [...s.flow.audit, log(SEC, 'Sent back to the Chair to double-check a logistics detail.')] } };
    }

    case 'publish': {
      if (!s.flow || !s.flow.chosen) return s;
      const v = a.dist?.version;
      const line = a.dist?.ok
        ? `Published — the revised agenda is live${v ? ` (v${v})` : ''}. A PDF was generated, emails queued and the WhatsApp group posted.`
        : 'Published — the revised agenda is saved locally (the distribution server is offline, so emails and WhatsApp will go out once it is running).';
      const reports = s.flow.reportId
        ? s.reports.map((r) => (r.id === s.flow!.reportId ? { ...r, status: 'resolved' as const } : r))
        : s.reports;
      return { ...s, reports, flow: { ...s.flow, stage: 'published',
        distribution: a.dist, pdfUrl: a.pdfUrl,
        notifications: s.flow.chosen.notifications.map((n) => ({ ...n })),
        audit: [...s.flow.audit, log(SEC, line)] } };
    }

    case 'ack': {
      if (!s.flow) return s;
      const notifications = s.flow.notifications.map((n, i) => (i === a.idx ? { ...n, ack: true } : n));
      return { ...s, flow: { ...s.flow, notifications,
        audit: [...s.flow.audit, log(notifications[a.idx].to, 'Confirmed they have seen the change.')] } };
    }

    case 'rollback': {
      if (!s.flow) return s;
      return { ...s, flow: { ...s.flow, stage: 'rolledback',
        audit: [...s.flow.audit, log(SEC, 'Rolled back to the previous agenda.')] } };
    }

    case 'resetFlow': {
      // if the flow is abandoned before publishing, put its report back in the inbox
      const rid = s.flow?.reportId;
      const reports = rid
        ? s.reports.map((r) => (r.id === rid && r.status === 'handling' ? { ...r, status: 'new' as const } : r))
        : s.reports;
      return { ...s, reports, flow: undefined };
    }
  }
}

// ---- context surface ----
interface WorkflowApi extends WState {
  submitReport: (r: Omit<SpeakerReport, 'id' | 'at' | 'status'>) => void;
  startHandling: (report: SpeakerReport) => void;
  reportAndHandle: (dis: Disruption) => void;
  chooseOption: (opt: AgentOption, useClaude: boolean) => Promise<void>;
  chairApprove: (edited?: boolean) => void;
  chairReject: (note: string) => void;
  sendBack: () => void;
  confirmPublish: () => Promise<void>;
  ack: (idx: number) => void;
  rollback: () => void;
  resetFlow: () => void;
}

const Ctx = createContext<WorkflowApi | null>(null);

const REPORT_POLL_MS = 20000;

export function WorkflowProvider({ confId, children }: { confId: string; children: ReactNode }) {
  const { seed, peopleById, sessionsById, fmtMin } = useAgenda();
  const [state, dispatch] = useReducer(reducer, { reports: [] });

  // Keep a live ref to the flow so effects can persist the latest without re-subscribing.
  const flowRef = useRef<Flow | undefined>(state.flow);
  flowRef.current = state.flow;

  const personName = (id: string): string => peopleById.get(id)?.name ?? 'A speaker';

  // derive the date of the first impacted session, for the print/publish path
  const impactedDayDate = (option: AgentOption): string | undefined => {
    const first = option.delta.find((op) => 'sessionId' in op);
    if (!first || !('sessionId' in first)) return undefined;
    return sessionsById.get(first.sessionId)?.date ?? undefined;
  };

  // ---- restore reports + in-flight flow on mount, then poll reports every 20s ----
  useEffect(() => {
    let on = true;
    getReports(confId).then((res) => { if (on && res?.reports) dispatch({ t: 'setReports', reports: res.reports }); });
    getFlowState(confId).then((res) => { if (on && res && res.flow) dispatch({ t: 'restoreFlow', flow: res.flow }); });
    const timer = setInterval(() => {
      getReports(confId).then((res) => {
        // don't clobber locally-handled reports while a flow is open — merge server 'new' reports
        if (!on || !res?.reports) return;
        dispatch({ t: 'setReports', reports: mergeReports(res.reports, flowRef.current) });
      });
    }, REPORT_POLL_MS);
    return () => { on = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confId]);

  // ---- persist the flow on every change (fire-and-forget, null-safe) ----
  const lastPersisted = useRef<string>('');
  useEffect(() => {
    const serialized = JSON.stringify(state.flow ?? null);
    if (serialized === lastPersisted.current) return;
    lastPersisted.current = serialized;
    void setFlowState(confId, state.flow ?? null);
  }, [confId, state.flow]);

  const api: WorkflowApi = {
    ...state,
    submitReport: (r) => {
      const report: SpeakerReport = {
        ...r, id: `rep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: nowISO(), status: 'new',
      };
      dispatch({ t: 'submitReport', report });
      // persist to the server; if it returns a canonical report, reconcile the id
      void postReport(confId, { personId: r.personId, kind: r.kind, etaMin: r.etaMin, reason: r.reason, source: r.source })
        .then((res) => { if (res?.report) dispatch({ t: 'submitReport', report: { ...res.report } }); });
    },

    startHandling: (report) => {
      const disruption: Disruption = {
        personId: report.personId, kind: report.kind, etaMin: report.etaMin,
        reason: report.reason, reportedAtMin: nowMin(),
      };
      const { options } = generateOptions(seed, disruption);
      dispatch({ t: 'startHandling', reportId: report.id, disruption, options,
        who: personName(report.personId), etaText: fmtMin(report.etaMin ?? 0) });
      void setReportStatus(confId, report.id, 'handling');
    },

    reportAndHandle: (dis) => {
      const { options } = generateOptions(seed, dis);
      dispatch({ t: 'directFlow', disruption: dis, options,
        who: personName(dis.personId), etaText: fmtMin(dis.etaMin ?? 0) });
    },

    chooseOption: async (opt, useClaude) => {
      if (useClaude && state.flow) {
        const enhanced = await enhanceProse(confId, opt, state.flow.disruption, personName(state.flow.disruption.personId));
        dispatch({ t: 'choose', opt: enhanced ?? opt });
      } else {
        dispatch({ t: 'choose', opt });
      }
    },

    chairApprove: (edited) => dispatch({ t: 'chairApprove', edited }),
    chairReject: (note) => dispatch({ t: 'chairReject', note }),
    sendBack: () => dispatch({ t: 'sendBack' }),

    confirmPublish: async () => {
      if (!state.flow?.chosen) return;
      const dayDate = impactedDayDate(state.flow.chosen);
      const dist = await publishRevision(
        confId, state.flow.chosen, state.flow.disruption,
        personName(state.flow.disruption.personId), dayDate,
      );
      const pdfUrl = dist?.publication?.pdfUrl ?? null;
      dispatch({ t: 'publish', dist: dist ?? null, pdfUrl });
      // mark the linked report resolved on the server too
      if (state.flow.reportId) void setReportStatus(confId, state.flow.reportId, 'resolved');
    },

    ack: (idx) => dispatch({ t: 'ack', idx }),
    rollback: () => dispatch({ t: 'rollback' }),
    resetFlow: () => {
      const rid = flowRef.current?.reportId;
      const wasHandling = flowRef.current
        && state.reports.find((r) => r.id === rid)?.status === 'handling';
      dispatch({ t: 'resetFlow' });
      if (rid && wasHandling) void setReportStatus(confId, rid, 'new');
    },
  };

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

// Merge freshly-fetched server reports with the local view: keep local status for any report
// that we're currently handling / have resolved so a poll doesn't reset it under the user.
function mergeReports(serverReports: SpeakerReport[], flow: Flow | undefined): SpeakerReport[] {
  if (!flow?.reportId) return serverReports;
  return serverReports.map((r) => (r.id === flow.reportId ? { ...r, status: 'handling' as const } : r));
}

export function useWorkflow(): WorkflowApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorkflow must be used inside <WorkflowProvider>');
  return v;
}
