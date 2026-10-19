export type UserRole = 'citizen' | 'officer' | 'admin';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  correlationId: string;
  detail?: string;
  instance?: string;
  errors?: Array<{ field: string; message: string }>;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export type ReportStatus =
  | 'Submitted'
  | 'Verified'
  | 'Assigned'
  | 'In Progress'
  | 'Resolved'
  | 'Closed'
  | 'Rejected'
  | 'Reopened';

export interface StatusHistoryItem {
  id: string;
  fromStatus: ReportStatus | null;
  toStatus: ReportStatus;
  changedBy?: string;
  note?: string;
  reasonCode?: string;
  changedAt: string;
}

export interface PhotoItem {
  imageId: string;
  width: number | null;
  height: number | null;
  thumbnailUrl: string;
  url: string;
}

export interface Report {
  id: string;
  reporterId: string;
  title: string;
  description: string;
  category: string;
  lat: number;
  lng: number;
  address?: string | null;
  status: ReportStatus;
  version: number;
  wardCode?: string | null;
  departmentCode?: string | null;
  photos?: PhotoItem[];
  history?: StatusHistoryItem[];
  createdAt: string;
  updatedAt: string;
}

export interface PublicReportSummary {
  id: string;
  title: string;
  category: string;
  lat: number;
  lng: number;
  status: ReportStatus;
  createdAt: string;
}

export interface PublicTimelineItem {
  fromStatus: ReportStatus | null;
  toStatus: ReportStatus;
  changedAt: string;
}

export interface PublicReportDetail {
  id: string;
  title: string;
  description: string;
  category: string;
  lat: number;
  lng: number;
  address?: string | null;
  status: ReportStatus;
  photos?: PhotoItem[];
  timeline: PublicTimelineItem[];
  createdAt: string;
}

export interface Category {
  slug: string;
  name: string;
  description: string;
  active?: boolean;
}

export interface ImageMetadata {
  imageId: string;
  status: 'pending' | 'ready' | 'rejected';
  width: number | null;
  height: number | null;
  gpsPresent: boolean;
}

export interface ImageUploadResult {
  imageId: string;
  status: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  pagination: Pagination;
}

export interface GeoJSONGeometry {
  type: string;
  coordinates: unknown;
}

export interface GeoJSONFeature {
  type: 'Feature';
  properties: {
    code: string;
    name: string;
    [key: string]: unknown;
  };
  geometry: GeoJSONGeometry;
}

export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

export interface Department {
  code: string;
  name: string;
  email: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface RoutingCategory {
  code: string;
  name: string;
  departmentCode: string;
  slaHours: number;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface Ward {
  code: string;
  name: string;
  active: boolean;
  geometry?: GeoJSONGeometry;
}

export interface StaffReportsParams {
  status?: string[];
  category?: string;
  department?: string;
  ward?: string;
  q?: string;
  createdAfter?: string;
  createdBefore?: string;
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

export interface AnalyticsSummary {
  totalReports: number;
  openReports: number;
  resolvedReports?: number;
  averageResolutionHours?: number;
  avgResolutionHours?: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  byWard: Record<string, number>;
  byDepartment: Record<string, number>;
}

export interface AuditLogItem {
  id: string;
  eventId: string;
  eventType: string;
  eventVersion: number;
  subjectId: string;
  correlationId: string;
  actorId?: string | null;
  occurredAt: string;
  recordedAt: string;
  payload: Record<string, unknown>;
}

export interface AuditLogResponse {
  items: AuditLogItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface UserListParams {
  role?: string;
  active?: boolean;
  q?: string;
  page?: number;
  limit?: number;
}

export interface UserListResponse {
  items: User[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
