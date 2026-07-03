// Conference-scoped server state: speaker reports and the in-flight approval workflow.
// All calls are NULL-SAFE — when the backend is unreachable the workflow provider falls
// back to memory-only behaviour, exactly like the current app.
import { apiGet, apiPost } from './api';
import type { SpeakerReport, Flow } from './workflow';

// ---- reports ----
export async function getReports(confId: string): Promise<{ reports: SpeakerReport[] } | null> {
  return apiGet<{ reports: SpeakerReport[] }>(`/c/${confId}/reports`);
}

export async function postReport(
  confId: string,
  body: { personId: string; kind: 'delay' | 'cancel'; etaMin: number | null; reason: string; source: 'speaker' | 'secretariat' },
): Promise<{ report: SpeakerReport } | null> {
  return apiPost<{ report: SpeakerReport }>(`/c/${confId}/reports`, body);
}

export async function setReportStatus(
  confId: string,
  reportId: string,
  status: 'handling' | 'resolved' | 'new',
): Promise<{ ok: boolean } | null> {
  return apiPost<{ ok: boolean }>(`/c/${confId}/reports/${reportId}`, { status });
}

// ---- in-flight approval workflow (persisted so it survives reloads / role switches) ----
export async function getFlowState(confId: string): Promise<{ flow: Flow | null } | null> {
  return apiGet<{ flow: Flow | null }>(`/c/${confId}/state`);
}

export async function setFlowState(confId: string, flow: Flow | null): Promise<{ ok: boolean } | null> {
  return apiPost<{ ok: boolean }>(`/c/${confId}/state`, { flow });
}
