import { apiClient } from './client.js';
import { Category, PaginatedResponse, PublicReportDetail, PublicReportSummary } from './types.js';

export async function getPublicCategoriesApi(): Promise<Category[]> {
  return apiClient<Category[]>('/public/categories', {
    method: 'GET',
    requiresAuth: false
  });
}

export interface ListPublicReportsParams {
  bbox?: string;
  category?: string;
  status?: 'open' | 'all';
  page?: number;
  pageSize?: number;
}

export async function getPublicReportsApi(
  params: ListPublicReportsParams = {}
): Promise<PaginatedResponse<PublicReportSummary>> {
  const searchParams = new URLSearchParams();
  if (params.bbox) searchParams.set('bbox', params.bbox);
  if (params.category) searchParams.set('category', params.category);
  if (params.status) searchParams.set('status', params.status);
  if (params.page) searchParams.set('page', String(params.page));
  if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));

  const qs = searchParams.toString();
  const endpoint = qs ? `/public/reports?${qs}` : '/public/reports';

  return apiClient<PaginatedResponse<PublicReportSummary>>(endpoint, {
    method: 'GET',
    requiresAuth: false
  });
}

export async function getPublicReportDetailApi(id: string): Promise<PublicReportDetail> {
  return apiClient<PublicReportDetail>(`/public/reports/${id}`, {
    method: 'GET',
    requiresAuth: false
  });
}
