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
