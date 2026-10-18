import React, { useEffect } from 'react';
import { useParams, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker } from 'react-leaflet';
import { getPublicReportDetailApi } from '../../api/public.js';
import { formatDateTime } from '../../lib/format.js';
import { createStatusMarkerIcon, fixLeafletDefaultIcons } from '../../lib/geo.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { Spinner } from '../../components/Spinner.js';
import { Card } from '../../components/Card.js';
import { Button } from '../../components/Button.js';
import { ApiError } from '../../api/client.js';

export const PublicReportDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();

  useEffect(() => {
    fixLeafletDefaultIcons();
  }, []);

  const {
    data: report,
    isLoading,
    error
  } = useQuery({
    queryKey: ['public', 'report', id],
    queryFn: () => getPublicReportDetailApi(id!),
    enabled: !!id,
    retry: false
  });

  if (isLoading) {
    return (
      <div className="flex justify-center items-center py-16" aria-live="polite">
        <Spinner size="lg" label="Loading report details..." />
      </div>
    );
  }

  // Handle 404
  if (error || !report) {
    const is404 = error instanceof ApiError && (error.status === 404 || error.code === 'not_found');
    return (
      <div className="max-w-xl mx-auto py-12">
        <Card surface className="text-center p-8">
          <h1 className="text-2xl font-semibold text-text mb-2">
            {is404 ? 'Report Not Found' : 'Error Loading Report'}
          </h1>
          <p className="text-sm text-text-muted mb-6">
            {is404
              ? 'The requested civic issue report does not exist or may have been removed.'
              : (error as Error)?.message || 'Failed to load report information.'}
          </p>
          <Link to="/">
            <Button variant="primary" size="sm">
              Back to Civic Map
            </Button>
          </Link>
        </Card>
      </div>
    );
  }

  const primaryPhoto = report.photos && report.photos.length > 0 ? report.photos[0] : null;

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto">
      {/* Navigation Breadcrumb */}
      <div className="text-sm text-text-muted">
        <Link to="/" className="link">
          &larr; Back to all reports
        </Link>
      </div>

      {/* Main Details Card */}
      <Card className="flex flex-col gap-6">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <StatusBadge status={report.status} />
              <span className="text-xs uppercase font-medium text-text-muted">
                {report.category}
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-semibold text-text">{report.title}</h1>
            <div className="text-xs text-text-muted mt-2">
              Reported on{' '}
              <time
                dateTime={report.createdAt}
                title={report.createdAt}
                className="font-medium text-text"
              >
                {formatDateTime(report.createdAt)}
              </time>
              {report.address && <span> • {report.address}</span>}
            </div>
          </div>
        </div>

        {/* Description */}
        <div>
          <h2 className="text-base font-semibold text-text mb-2">Description</h2>
          <p className="text-sm text-text whitespace-pre-wrap leading-relaxed">
            {report.description || 'No detailed description provided.'}
          </p>
        </div>

        {/* Photo Gallery (when present) */}
        {primaryPhoto && (
          <div>
            <h2 className="text-base font-semibold text-text mb-2">Attached Photo</h2>
            <div className="inline-block rounded-md border border-border overflow-hidden">
              <a
                href={primaryPhoto.url}
                target="_blank"
                rel="noopener noreferrer"
                title="View full resolution image in new tab"
              >
                <img
                  src={primaryPhoto.thumbnailUrl}
                  alt={`Civic issue documentation: ${report.title}`}
                  className="max-h-64 object-cover hover:opacity-90 transition-opacity"
                />
              </a>
            </div>
            <span className="block text-xs text-text-muted mt-1">
              Click photo to view full resolution
            </span>
          </div>
        )}

        {/* Location Map */}
        <div>
          <h2 className="text-base font-semibold text-text mb-2">Location</h2>
          <div className="w-full h-64 rounded-md border border-border overflow-hidden">
            <MapContainer
              center={[report.lat, report.lng]}
              zoom={14}
              style={{ width: '100%', height: '100%' }}
              scrollWheelZoom={false}
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <Marker
                position={[report.lat, report.lng]}
                icon={createStatusMarkerIcon(report.status)}
              />
            </MapContainer>
          </div>
          <span className="text-xs text-text-muted mt-1 block">
            Coordinates: {report.lat.toFixed(4)}, {report.lng.toFixed(4)}
          </span>
        </div>

        {/* Status Timeline */}
        <div>
          <h2 className="text-base font-semibold text-text mb-3">Status Timeline</h2>
          {report.timeline && report.timeline.length > 0 ? (
            <div className="flex flex-col gap-3 pl-2 border-l border-border">
              {report.timeline.map((item, index) => (
                <div key={index} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={item.toStatus} />
                    <time
                      dateTime={item.changedAt}
                      title={item.changedAt}
                      className="text-xs text-text-muted"
                    >
                      {formatDateTime(item.changedAt)}
                    </time>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-muted">No timeline records available.</p>
          )}
        </div>
      </Card>
    </div>
  );
};
