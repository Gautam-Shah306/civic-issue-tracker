import { apiClient } from './client.js';
import type { Department, GeoJSONFeatureCollection, RoutingCategory, Ward } from './types.js';

export async function getWardsApi(): Promise<GeoJSONFeatureCollection> {
  return apiClient<GeoJSONFeatureCollection>('/routing/wards', {
    method: 'GET',
    requiresAuth: false
  });
}

export async function patchWardApi(
  code: string,
  payload: { name?: string; active?: boolean }
): Promise<Ward> {
  return apiClient<Ward>(`/routing/wards/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    requiresAuth: true
  });
}

export async function listDepartmentsApi(all = false): Promise<Department[]> {
  const endpoint = all ? '/routing/departments?all=true' : '/routing/departments';
  return apiClient<Department[]>(endpoint, {
    method: 'GET',
    requiresAuth: all
  });
}

export async function createDepartmentApi(payload: {
  code: string;
  name: string;
  email: string;
  active?: boolean;
}): Promise<Department> {
  return apiClient<Department>('/routing/departments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    requiresAuth: true
  });
}

export async function patchDepartmentApi(
  code: string,
  payload: { name?: string; email?: string; active?: boolean }
): Promise<Department> {
  return apiClient<Department>(`/routing/departments/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    requiresAuth: true
  });
}

export async function listCategoriesApi(all = false): Promise<RoutingCategory[]> {
  const endpoint = all ? '/routing/categories?all=true' : '/routing/categories';
  return apiClient<RoutingCategory[]>(endpoint, {
    method: 'GET',
    requiresAuth: all
  });
}

export async function createCategoryApi(payload: {
  slug: string;
  name: string;
  departmentCode: string;
  active?: boolean;
}): Promise<RoutingCategory> {
  return apiClient<RoutingCategory>('/routing/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    requiresAuth: true
  });
}

export async function patchCategoryApi(
  slug: string,
  payload: { name?: string; departmentCode?: string; active?: boolean }
): Promise<RoutingCategory> {
  return apiClient<RoutingCategory>(`/routing/categories/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    requiresAuth: true
  });
}

export async function reassignReportApi(
  reportId: string,
  payload: { departmentCode: string; wardCode?: string }
): Promise<{
  reportId: string;
  departmentCode: string;
  wardCode?: string;
  source: string;
  assignedAt: string;
}> {
  return apiClient(`/routing/reports/${encodeURIComponent(reportId)}/reassign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    requiresAuth: true
  });
}
