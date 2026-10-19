import { apiClient } from './client.js';
import type { AnalyticsSummary, AuditLogResponse } from './types.js';

export interface AuditLogQueryParams {
  page?: number;
  pageSize?: number;
  eventType?: string;
  subjectId?: string;
  from?: string;
  to?: string;
}

export async function getAnalyticsSummaryApi(): Promise<AnalyticsSummary> {
  return apiClient<AnalyticsSummary>('/analytics/summary', {
    method: 'GET',
    requiresAuth: true
  });
}

export async function getAuditLogsApi(params: AuditLogQueryParams = {}): Promise<AuditLogResponse> {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set('page', String(params.page));
  if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params.eventType) searchParams.set('eventType', params.eventType);
  if (params.subjectId) searchParams.set('subjectId', params.subjectId);
  if (params.from) searchParams.set('from', params.from);
  if (params.to) searchParams.set('to', params.to);

  const qs = searchParams.toString();
  const endpoint = qs ? `/analytics/audit?${qs}` : '/analytics/audit';

  return apiClient<AuditLogResponse>(endpoint, {
    method: 'GET',
    requiresAuth: true
  });
}
