import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker } from 'react-leaflet';
import { getReportApi, updateReportStatusApi } from '../../api/reports.js';
import { formatDateTime } from '../../lib/format.js';
import { createStatusMarkerIcon, fixLeafletDefaultIcons } from '../../lib/geo.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { Card } from '../../components/Card.js';
import { Button } from '../../components/Button.js';
import { TextArea } from '../../components/TextArea.js';
import { Spinner } from '../../components/Spinner.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { ApiError } from '../../api/client.js';

export const MyReportDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  useEffect(() => {
    fixLeafletDefaultIcons();
  }, []);

  const [showReopenConfirm, setShowReopenConfirm] = useState(false);
  const [reopenNote, setReopenNote] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const {
    data: report,
    isLoading,
    error
  } = useQuery({
    queryKey: ['report', id],
    queryFn: () => getReportApi(id!),
    enabled: !!id
  });

  const reopenMutation = useMutation({
    mutationFn: () =>
      updateReportStatusApi(id!, {
        toStatus: 'Reopened',
        note: reopenNote.trim() || undefined
      }),
    onSuccess: (updatedReport) => {
      queryClient.setQueryData(['report', id], updatedReport);
      setShowReopenConfirm(false);
      setReopenNote('');
      setActionError(null);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        setActionError(err.message || 'Failed to reopen report');
      } else {
        setActionError('Failed to reopen report. Please try again.');
      }
    }
  });

  if (isLoading) {
    return (
      <div className="flex justify-center items-center py-16" aria-live="polite">
        <Spinner size="lg" label="Loading report details..." />
      </div>
    );
  }

  if (error || !report) {
    const isNotFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="max-w-xl mx-auto py-12">
        <Card surface className="text-center p-8">
          <h1 className="text-2xl font-semibold text-text mb-2">
            {isNotFound ? 'Report Not Found' : 'Error'}
          </h1>
          <p className="text-sm text-text-muted mb-6">
            {isNotFound
              ? 'This report could not be found or you do not have permission to view it.'
              : (error as Error)?.message || 'Failed to load report.'}
          </p>
          <Link to="/my">
            <Button variant="primary" size="sm">
              Back to My Reports
            </Button>
          </Link>
        </Card>
      </div>
    );
  }

  const canReopen = report.status === 'Resolved' || report.status === 'Closed';
  const primaryPhoto = report.photos && report.photos.length > 0 ? report.photos[0] : null;

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto">
      {/* Navigation Breadcrumb */}
      <div className="flex items-center justify-between">
        <Link to="/my" className="link text-sm">
          &larr; Back to My Reports
        </Link>
        <Link to={`/reports/${report.id}`} className="text-xs text-text-muted hover:underline">
          View public page &rarr;
        </Link>
      </div>

      {actionError && <ErrorNotice message={actionError} />}

      <Card className="flex flex-col gap-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <StatusBadge status={report.status} />
              <span className="text-xs uppercase font-medium text-text-muted">
                {report.category}
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-semibold text-text">{report.title}</h1>
            <div className="text-xs text-text-muted mt-2 flex flex-wrap gap-4">
              <span>
                Reported on:{' '}
                <time dateTime={report.createdAt} className="font-medium text-text">
                  {formatDateTime(report.createdAt)}
                </time>
              </span>
              {report.wardCode && (
                <span>
                  Ward: <strong className="text-text">{report.wardCode}</strong>
                </span>
              )}
              {report.departmentCode && (
                <span>
                  Department: <strong className="text-text">{report.departmentCode}</strong>
                </span>
              )}
            </div>
          </div>

          {/* Reopen Action button */}
          {canReopen && !showReopenConfirm && (
            <Button variant="secondary" size="md" onClick={() => setShowReopenConfirm(true)}>
              Reopen Report
            </Button>
          )}
        </div>

        {/* Reopen Confirmation Panel */}
        {showReopenConfirm && (
          <div className="p-4 rounded-md border border-warning-text bg-warning-bg flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-warning-text">Confirm Reopening of Report</h3>
            <p className="text-xs text-warning-text">
              Please explain why this issue is not resolved. Municipal officers will be notified to
              re-investigate.
            </p>
            <TextArea
              id="reopen-note"
              label="Reason for reopening"
              value={reopenNote}
              onChange={(e) => setReopenNote(e.target.value)}
              maxLength={500}
              showCount
              hint="Explain what remains unresolved"
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setShowReopenConfirm(false);
                  setReopenNote('');
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={reopenMutation.isPending}
                onClick={() => reopenMutation.mutate()}
              >
                {reopenMutation.isPending ? 'Submitting...' : 'Confirm Reopen'}
              </Button>
            </div>
          </div>
        )}

        {/* Description */}
        <div>
          <h2 className="text-base font-semibold text-text mb-2">Description</h2>
          <p className="text-sm text-text whitespace-pre-wrap leading-relaxed">
            {report.description || 'No detailed description provided.'}
          </p>
          {report.address && (
            <p className="text-xs text-text-muted mt-2">
              <strong>Address:</strong> {report.address}
            </p>
          )}
        </div>

        {/* Attached Photo */}
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
                  alt={report.title}
                  className="max-h-64 object-cover hover:opacity-90 transition-opacity"
                />
              </a>
            </div>
          </div>
        )}

        {/* Map */}
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
        </div>

        {/* Status History */}
        <div>
          <h2 className="text-base font-semibold text-text mb-3">Status History & Updates</h2>
          {report.history && report.history.length > 0 ? (
            <div className="flex flex-col gap-3 pl-3 border-l border-border">
              {report.history.map((h) => (
                <div key={h.id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={h.toStatus} />
                    <time dateTime={h.changedAt} className="text-xs text-text-muted">
                      {formatDateTime(h.changedAt)}
                    </time>
                  </div>
                  {h.note && (
                    <p className="text-xs text-text bg-surface p-2 rounded-md border border-border mt-1">
                      {h.note}
                    </p>
                  )}
                  {h.reasonCode && (
                    <span className="text-xs text-danger-text">
                      Rejection Reason: {h.reasonCode}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-muted">No history entries available.</p>
          )}
        </div>
      </Card>
    </div>
  );
};
