import { apiClient } from './client.js';
import { PaginatedResponse, Report, ReportStatus } from './types.js';

export interface CreateReportPayload {
  title: string;
  description: string;
  category: string;
  location: {
    lat: number;
    lng: number;
    address?: string;
  };
  photoIds?: string[];
}

export async function submitReportApi(
  payload: CreateReportPayload,
  idempotencyKey?: string
): Promise<Report> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  return apiClient<Report>('/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    requiresAuth: true
  });
}

export interface ListMineParams {
  page?: number;
  pageSize?: number;
  status?: ReportStatus;
}

export async function getMineReportsApi(
  params: ListMineParams = {}
): Promise<PaginatedResponse<Report>> {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set('page', String(params.page));
  if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params.status) searchParams.set('status', params.status);

  const qs = searchParams.toString();
  const endpoint = qs ? `/reports/mine?${qs}` : '/reports/mine';

  return apiClient<PaginatedResponse<Report>>(endpoint, {
    method: 'GET',
    requiresAuth: true
  });
}

export async function getReportApi(id: string): Promise<Report> {
  return apiClient<Report>(`/reports/${id}`, {
    method: 'GET',
    requiresAuth: true
  });
}

export interface UpdateStatusPayload {
  toStatus: ReportStatus;
  note?: string;
  reasonCode?: string;
}

export async function updateReportStatusApi(
  id: string,
  payload: UpdateStatusPayload
): Promise<Report> {
  return apiClient<Report>(`/reports/${id}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    requiresAuth: true
  });
}
