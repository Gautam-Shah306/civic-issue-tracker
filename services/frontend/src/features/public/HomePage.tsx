import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker, Popup, GeoJSON, useMapEvents } from 'react-leaflet';
import { getPublicCategoriesApi, getPublicReportsApi } from '../../api/public.js';
import { getWardsApi } from '../../api/routing.js';
import { PublicReportSummary } from '../../api/types.js';
import {
  boundsToBboxString,
  createStatusMarkerIcon,
  fixLeafletDefaultIcons
} from '../../lib/geo.js';
import { formatDateTime } from '../../lib/format.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { Button } from '../../components/Button.js';
import { Select } from '../../components/Select.js';
import { Pagination } from '../../components/Pagination.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Card } from '../../components/Card.js';

// Map event listener component to capture bounding box on pan/zoom
function MapBoundsListener({ onBoundsChange }: { onBoundsChange: (bbox: string) => void }) {
  const map = useMapEvents({
    moveend: () => {
      const bounds = map.getBounds();
      onBoundsChange(boundsToBboxString(bounds));
    }
  });

  useEffect(() => {
    const bounds = map.getBounds();
    onBoundsChange(boundsToBboxString(bounds));
  }, [map, onBoundsChange]);

  return null;
}

export const HomePage: React.FC = () => {
  useEffect(() => {
    fixLeafletDefaultIcons();
  }, []);

  const [activeTab, setActiveTab] = useState<'map' | 'list'>('map');
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'open' | 'all'>('open');
  const [showWards, setShowWards] = useState<boolean>(false);
  const [bbox, setBbox] = useState<string>('');
  const [listPage, setListPage] = useState<number>(1);

  // Debounced bbox handler
  const handleBoundsChange = useCallback((newBbox: string) => {
    setBbox(newBbox);
  }, []);

  // Fetch categories
  const { data: categories = [], isError: isCatError } = useQuery({
    queryKey: ['public', 'categories'],
    queryFn: getPublicCategoriesApi
  });

  // Fetch wards GeoJSON
  const { data: wardsData } = useQuery({
    queryKey: ['routing', 'wards'],
    queryFn: getWardsApi,
    enabled: showWards
  });

  // Fetch reports for map (based on visible bbox)
  const {
    data: mapReportsData,
    isLoading: isMapLoading,
    isError: isMapError,
    refetch: refetchMap
  } = useQuery({
    queryKey: ['public', 'reports', 'map', bbox, selectedCategory, statusFilter],
    queryFn: () =>
      getPublicReportsApi({
        bbox: bbox || undefined,
        category: selectedCategory || undefined,
        status: statusFilter,
        pageSize: 50
      }),
    enabled: activeTab === 'map'
  });

  // Fetch reports for list view (paginated)
  const {
    data: listReportsData,
    isLoading: isListLoading,
    isError: isListError,
    refetch: refetchList
  } = useQuery({
    queryKey: ['public', 'reports', 'list', listPage, selectedCategory, statusFilter],
    queryFn: () =>
      getPublicReportsApi({
        category: selectedCategory || undefined,
        status: statusFilter,
        page: listPage,
        pageSize: 10
      }),
    enabled: activeTab === 'list'
  });

  const categoryOptions = useMemo(() => {
    return [
      { value: '', label: 'All Categories' },
      ...categories.map((c) => ({ value: c.slug, label: c.name }))
    ];
  }, [categories]);

  const mapReports = mapReportsData?.items || [];
  const listReports = listReportsData?.items || [];
  const totalListPages = listReportsData?.pagination.totalPages || 1;

  // Resolve outline color safely from CSS variable without hardcoding hex
  const wardStyle = useMemo(() => {
    let color = 'gray';
    if (typeof window !== 'undefined') {
      color =
        getComputedStyle(document.documentElement)
          .getPropertyValue('--color-border-strong')
          .trim() || 'gray';
    }
    return {
      color,
      weight: 2,
      fillOpacity: 0.05
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-text">Civic Issues</h1>
          <p className="text-sm text-text-muted mt-1">
            Browse, track, and verify reported public infrastructure issues across the city.
          </p>
        </div>
        <Link to="/submit">
          <Button variant="primary" size="md">
            Report an Issue
          </Button>
        </Link>
      </div>

      {/* Filter and View Controls Bar */}
      <Card surface className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4 flex-1">
          <div className="w-48">
            <Select
              id="filter-category"
              label="Category"
              options={categoryOptions}
              value={selectedCategory}
              onChange={(e) => {
                setSelectedCategory(e.target.value);
                setListPage(1);
              }}
              controlSize="sm"
            />
          </div>

          <div className="w-36">
            <Select
              id="filter-status"
              label="Status Filter"
              options={[
                { value: 'open', label: 'Open Issues' },
                { value: 'all', label: 'All Issues' }
              ]}
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as 'open' | 'all');
                setListPage(1);
              }}
              controlSize="sm"
            />
          </div>

          {activeTab === 'map' && (
            <div className="flex items-center gap-2 pt-6">
              <input
                id="toggle-wards"
                type="checkbox"
                checked={showWards}
                onChange={(e) => setShowWards(e.target.checked)}
                className="w-4 h-4 rounded-sm border-border text-primary focus-ring"
              />
              <label
                htmlFor="toggle-wards"
                className="text-sm font-medium text-text cursor-pointer"
              >
                Show Ward Boundaries
              </label>
            </div>
          )}
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center border border-border rounded-md p-1 bg-bg">
          <button
            type="button"
            onClick={() => setActiveTab('map')}
            className={`px-3 py-1 text-sm font-medium rounded-sm focus-ring transition-colors ${
              activeTab === 'map'
                ? 'bg-primary text-primary-text'
                : 'text-text-muted hover:text-text'
            }`}
            aria-pressed={activeTab === 'map'}
          >
            Map View
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('list')}
            className={`px-3 py-1 text-sm font-medium rounded-sm focus-ring transition-colors ${
              activeTab === 'list'
                ? 'bg-primary text-primary-text'
                : 'text-text-muted hover:text-text'
            }`}
            aria-pressed={activeTab === 'list'}
          >
            List View
          </button>
        </div>
      </Card>

      {/* Error Notices */}
      {isCatError && (
        <ErrorNotice message="Failed to load categories. Some filter options may be missing." />
      )}

      {/* Main View Area */}
      {activeTab === 'map' ? (
        <div className="flex flex-col gap-2">
          {isMapError && (
            <ErrorNotice
              title="Map Data Error"
              message="Failed to load reports for the visible map area."
              onRetry={() => refetchMap()}
            />
          )}

          <div className="relative w-full h-map rounded-lg border border-border overflow-hidden">
            {isMapLoading && (
              <div
                className="absolute top-4 right-4 z-10 bg-bg px-3 py-2 rounded-md shadow-sm border border-border flex items-center gap-2 text-xs font-medium"
                aria-live="polite"
              >
                <Spinner size="sm" />
                <span>Loading map reports...</span>
              </div>
            )}

            <MapContainer
              center={[23.03, 72.58]}
              zoom={11}
              style={{ width: '100%', height: '100%' }}
              scrollWheelZoom={true}
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />

              <MapBoundsListener onBoundsChange={handleBoundsChange} />

              {showWards && wardsData && (
                <GeoJSON
                  data={wardsData as unknown as GeoJSON.GeoJsonObject}
                  style={() => wardStyle}
                />
              )}

              {mapReports.map((report: PublicReportSummary) => (
                <Marker
                  key={report.id}
                  position={[report.lat, report.lng]}
                  icon={createStatusMarkerIcon(report.status)}
                >
                  <Popup>
                    <div className="p-1 flex flex-col gap-1 max-w-xs text-text">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <StatusBadge status={report.status} />
                        <span className="text-xs text-text-muted capitalize">
                          {report.category}
                        </span>
                      </div>
                      <h4 className="text-sm font-semibold leading-snug">{report.title}</h4>
                      <span className="text-xs text-text-muted">
                        Reported: {formatDateTime(report.createdAt)}
                      </span>
                      <Link
                        to={`/reports/${report.id}`}
                        className="text-xs font-medium text-text underline mt-1"
                      >
                        View details &rarr;
                      </Link>
                    </div>
                  </Popup>
                </Marker>
              ))}
            </MapContainer>
          </div>

          <span className="text-xs text-text-muted">
            Showing {mapReports.length} reports in the visible map region. Move or zoom the map to
            load more.
          </span>
        </div>
      ) : (
        /* List View */
        <div className="flex flex-col gap-4">
          {isListLoading ? (
            <div className="flex justify-center items-center py-16" aria-live="polite">
              <Spinner size="lg" label="Loading reports list..." />
            </div>
          ) : isListError ? (
            <ErrorNotice
              title="Reports List Error"
              message="Failed to load civic issues list."
              onRetry={() => refetchList()}
            />
          ) : listReports.length === 0 ? (
            <EmptyState
              title="No reports found"
              description="No civic issues match your current filters. Try changing category or status."
              action={
                <Link to="/submit">
                  <Button variant="primary" size="sm">
                    Submit First Report
                  </Button>
                </Link>
              }
            />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {listReports.map((report) => (
                  <Card key={report.id} className="flex flex-col justify-between gap-3">
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <StatusBadge status={report.status} />
                        <span className="text-xs font-medium text-text-muted uppercase">
                          {report.category}
                        </span>
                      </div>
                      <Link
                        to={`/reports/${report.id}`}
                        className="text-base font-semibold text-text hover:underline block"
                      >
                        {report.title}
                      </Link>
                    </div>
                    <div className="flex items-center justify-between text-xs text-text-muted pt-2 border-t border-border">
                      <time dateTime={report.createdAt} title={report.createdAt}>
                        {formatDateTime(report.createdAt)}
                      </time>
                      <Link to={`/reports/${report.id}`} className="link font-medium">
                        View details &rarr;
                      </Link>
                    </div>
                  </Card>
                ))}
              </div>

              <Pagination
                page={listPage}
                totalPages={totalListPages}
                onPageChange={(newPage) => setListPage(newPage)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
