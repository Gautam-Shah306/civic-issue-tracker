import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker } from 'react-leaflet';
import { getReportApi, updateReportStatusApi } from '../../api/reports.js';
import { listDepartmentsApi, getWardsApi, reassignReportApi } from '../../api/routing.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { formatDateTime } from '../../lib/format.js';
import { createStatusMarkerIcon, fixLeafletDefaultIcons } from '../../lib/geo.js';
import {
  getAllowedTransitions,
  requiresReason,
  RejectionReasonCode
} from '../../lib/transitions.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { Card } from '../../components/Card.js';
import { Button } from '../../components/Button.js';
import { Select } from '../../components/Select.js';
import { TextArea } from '../../components/TextArea.js';
import { Spinner } from '../../components/Spinner.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { CopyButton } from '../../components/CopyButton.js';
import { ReasonSelect } from '../../components/ReasonSelect.js';
import { ConfirmPanel } from '../../components/ConfirmPanel.js';
import { ApiError } from '../../api/client.js';
import type { ReportStatus } from '../../api/types.js';

export const StaffReportDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    fixLeafletDefaultIcons();
  }, []);

  // Action panel state
  const [targetStatus, setTargetStatus] = useState<ReportStatus | ''>('');
  const [rejectionReason, setRejectionReason] = useState<RejectionReasonCode | ''>('');
  const [transitionNote, setTransitionNote] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Admin reassignment state
  const [reassignDept, setReassignDept] = useState('');
  const [reassignWard, setReassignWard] = useState('');
  const [reassignError, setReassignError] = useState<string | null>(null);
  const [reassignSuccess, setReassignSuccess] = useState(false);

  // Fetch report details
  const {
    data: report,
    isLoading,
    error
  } = useQuery({
    queryKey: ['report', id],
    queryFn: () => getReportApi(id!),
    enabled: !!id
  });

  // Fetch departments and wards for admin reassignment
  const { data: departments = [] } = useQuery({
    queryKey: ['departments', 'active'],
    queryFn: () => listDepartmentsApi(false),
    enabled: user?.role === 'admin'
  });

  const { data: wardsData } = useQuery({
    queryKey: ['wards'],
    queryFn: () => getWardsApi(),
    enabled: user?.role === 'admin'
  });

  const wards =
    wardsData?.features.map((f) => ({
      code: f.properties.code,
      name: f.properties.name
    })) || [];

  // Transition mutation
  const transitionMutation = useMutation({
    mutationFn: async () => {
      if (!targetStatus) throw new Error('Target status is required');
      if (requiresReason(targetStatus) && !rejectionReason) {
        throw new Error('A reason is mandatory for rejection');
      }

      return updateReportStatusApi(id!, {
        toStatus: targetStatus,
        reasonCode: rejectionReason || undefined,
        note: transitionNote.trim() || undefined
      });
    },
    onSuccess: (updatedReport) => {
      queryClient.setQueryData(['report', id], updatedReport);
      queryClient.invalidateQueries({ queryKey: ['staff-reports'] });
      queryClient.invalidateQueries({ queryKey: ['analytics-summary'] });
      setShowConfirm(false);
      setTargetStatus('');
      setRejectionReason('');
      setTransitionNote('');
      setActionError(null);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        setActionError(err.message || 'Failed to update report status');
      } else {
        setActionError((err as Error).message || 'Failed to update report status');
      }
    }
  });

  // Reassignment mutation
  const reassignMutation = useMutation({
    mutationFn: async () => {
      if (!reassignDept) throw new Error('Please select a department');
      return reassignReportApi(id!, {
        departmentCode: reassignDept,
        wardCode: reassignWard || undefined
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['report', id] });
      queryClient.invalidateQueries({ queryKey: ['staff-reports'] });
      setReassignSuccess(true);
      setReassignError(null);
      setTimeout(() => setReassignSuccess(false), 3000);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        setReassignError(err.message || 'Failed to reassign report');
      } else {
        setReassignError((err as Error).message || 'Failed to reassign report');
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
          <Link to="/staff">
            <Button variant="primary">Back to Staff Queue</Button>
          </Link>
        </Card>
      </div>
    );
  }

  const allowedTransitions = getAllowedTransitions(report.status, user?.role);
  const markerIcon = createStatusMarkerIcon(report.status);

  return (
    <div className="flex flex-col gap-6 max-w-5xl mx-auto py-4">
      {/* Back navigation */}
      <div>
        <Link
          to="/staff"
          className="text-sm font-medium text-text-muted hover:text-primary transition-colors flex items-center gap-1"
        >
          ← Back to Staff Queue
        </Link>
      </div>

      {/* Main Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 pb-4 border-b border-border">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-text-muted">#{report.id.substring(0, 8)}</span>
            <CopyButton text={report.id} label="Copy ID" />
            <StatusBadge status={report.status} />
          </div>
          <h1 className="text-3xl font-semibold text-text leading-tight">{report.title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <span>Submitted {formatDateTime(report.createdAt)}</span>
            <span>•</span>
            <span className="capitalize">Category: {report.category.replace(/-/g, ' ')}</span>
            {report.departmentCode && (
              <>
                <span>•</span>
                <span className="uppercase">Dept: {report.departmentCode}</span>
              </>
            )}
            {report.wardCode && (
              <>
                <span>•</span>
                <span>Ward: {report.wardCode}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Details, Map, History */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          {/* Description Card */}
          <Card surface className="p-6 flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-text">Description</h2>
            <p className="text-sm text-text whitespace-pre-wrap leading-relaxed">
              {report.description || 'No detailed description provided.'}
            </p>

            <div className="pt-4 border-t border-border flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-text-muted">
              <div className="flex items-center gap-2">
                <span>Reporter ID:</span>
                <span className="font-mono">{report.reporterId.substring(0, 8)}...</span>
                <CopyButton text={report.reporterId} label="Copy" />
              </div>
              <div>
                <span>Last updated: {formatDateTime(report.updatedAt)}</span>
              </div>
            </div>
          </Card>

          {/* Photos */}
          {report.photos && report.photos.length > 0 && (
            <Card surface className="p-6 flex flex-col gap-4">
              <h2 className="text-lg font-semibold text-text">Photos</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {report.photos.map((p) => (
                  <div
                    key={p.imageId}
                    className="rounded-lg overflow-hidden border border-border bg-bg"
                  >
                    <img
                      src={p.url || p.thumbnailUrl}
                      alt="Civic issue evidence"
                      className="w-full h-48 object-cover hover:scale-105 transition-transform duration-200"
                    />
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Location & Map */}
          <Card surface className="p-6 flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold text-text">Location</h2>
              {report.address && <p className="text-sm text-text-muted mt-1">{report.address}</p>}
              <p className="text-xs font-mono text-text-muted mt-0.5">
                Coordinates: {report.lat.toFixed(4)}, {report.lng.toFixed(4)}
              </p>
            </div>

            <div className="h-64 rounded-lg overflow-hidden border border-border">
              <MapContainer
                center={[report.lat, report.lng]}
                zoom={15}
                className="w-full h-full"
                scrollWheelZoom={false}
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <Marker position={[report.lat, report.lng]} icon={markerIcon} />
              </MapContainer>
            </div>
          </Card>

          {/* Status Timeline / History */}
          <Card surface className="p-6 flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-text">History & Audit Trail</h2>
            {report.history && report.history.length > 0 ? (
              <ol className="relative border-l border-border ml-3 flex flex-col gap-4">
                {report.history.map((h) => (
                  <li key={h.id} className="ml-4 flex flex-col gap-1">
                    <div className="absolute -left-1.5 mt-1.5 w-3 h-3 rounded-sm border border-bg bg-primary" />
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-text">
                        {h.fromStatus ? `${h.fromStatus} → ` : ''}
                        {h.toStatus}
                      </span>
                      <span className="text-xs text-text-muted">by {h.changedBy || 'system'}</span>
                    </div>
                    <time className="text-xs text-text-muted">{formatDateTime(h.changedAt)}</time>
                    {h.reasonCode && (
                      <span className="text-xs font-medium text-danger-text">
                        Reason: {h.reasonCode.replace(/_/g, ' ')}
                      </span>
                    )}
                    {h.note && (
                      <p className="text-xs text-text-muted italic bg-bg p-2 rounded-sm border border-border">
                        "{h.note}"
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs text-text-muted">No transition history recorded.</p>
            )}
          </Card>
        </div>

        {/* Right Col: Action & Reassignment Panels */}
        <div className="flex flex-col gap-6">
          {/* Status Progression Action Panel */}
          <Card surface className="p-6 flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-text">Report Action</h2>
            <p className="text-xs text-text-muted">
              Update report status in accordance with the municipal workflow matrix.
            </p>

            {actionError && <ErrorNotice title="Action failed" message={actionError} />}

            {allowedTransitions.length === 0 ? (
              <div className="p-4 rounded-md bg-bg border border-border text-xs text-text-muted text-center">
                No status transitions available for this report in status{' '}
                <strong>{report.status}</strong> with role{' '}
                <strong className="capitalize">{user?.role}</strong>.
              </div>
            ) : !showConfirm ? (
              <div className="flex flex-col gap-3">
                <Select
                  id="target-status"
                  label="Progress to Status"
                  options={[
                    { value: '', label: '-- Select next status --' },
                    ...allowedTransitions.map((s) => ({ value: s, label: s }))
                  ]}
                  value={targetStatus}
                  onChange={(e) => {
                    setTargetStatus(e.target.value as ReportStatus);
                    setActionError(null);
                  }}
                />

                {targetStatus && requiresReason(targetStatus) && (
                  <ReasonSelect value={rejectionReason} onChange={(r) => setRejectionReason(r)} />
                )}

                {targetStatus && (
                  <TextArea
                    id="transition-note"
                    label="Officer Note (optional)"
                    placeholder="Add operational notes or guidance..."
                    value={transitionNote}
                    onChange={(e) => setTransitionNote(e.target.value)}
                    maxLength={500}
                    rows={3}
                  />
                )}

                <Button
                  variant={targetStatus === 'Rejected' ? 'danger' : 'primary'}
                  disabled={!targetStatus || (requiresReason(targetStatus) && !rejectionReason)}
                  onClick={() => setShowConfirm(true)}
                  className="w-full mt-2"
                >
                  Proceed to {targetStatus || 'Update'}
                </Button>
              </div>
            ) : (
              <ConfirmPanel
                title={`Confirm Transition to ${targetStatus}`}
                description={`Are you sure you want to change the status of this report from ${report.status} to ${targetStatus}?`}
                confirmVariant={targetStatus === 'Rejected' ? 'danger' : 'primary'}
                isLoading={transitionMutation.isPending}
                onConfirm={() => transitionMutation.mutate()}
                onCancel={() => setShowConfirm(false)}
              >
                {rejectionReason && (
                  <div className="text-xs text-danger-text font-medium">
                    Reason: {rejectionReason}
                  </div>
                )}
                {transitionNote && (
                  <div className="text-xs text-text-muted italic">Note: "{transitionNote}"</div>
                )}
              </ConfirmPanel>
            )}
          </Card>

          {/* Admin Reassignment Panel */}
          {user?.role === 'admin' && (
            <Card surface className="p-6 flex flex-col gap-4">
              <h2 className="text-lg font-semibold text-text">Department Reassignment</h2>
              <p className="text-xs text-text-muted">
                Administratively reassign this report to a different active municipal department.
              </p>

              {reassignError && <ErrorNotice title="Reassignment failed" message={reassignError} />}

              {reassignSuccess && (
                <div
                  role="status"
                  aria-live="polite"
                  className="p-3 rounded-md bg-success-bg border border-success-text text-success-text text-xs font-medium"
                >
                  Report successfully reassigned.
                </div>
              )}

              <div className="flex flex-col gap-3">
                <Select
                  id="reassign-department"
                  label="Target Department"
                  options={[
                    { value: '', label: '-- Select Department --' },
                    ...departments.map((d) => ({
                      value: d.code,
                      label: `${d.name} (${d.code})`
                    }))
                  ]}
                  value={reassignDept}
                  onChange={(e) => setReassignDept(e.target.value)}
                />

                <Select
                  id="reassign-ward"
                  label="Target Ward (optional)"
                  options={[
                    { value: '', label: '-- Keep existing / None --' },
                    ...wards.map((w) => ({
                      value: w.code,
                      label: `${w.code} - ${w.name}`
                    }))
                  ]}
                  value={reassignWard}
                  onChange={(e) => setReassignWard(e.target.value)}
                />

                <Button
                  variant="secondary"
                  disabled={!reassignDept || reassignMutation.isPending}
                  loading={reassignMutation.isPending}
                  onClick={() => reassignMutation.mutate()}
                  className="w-full mt-2"
                >
                  Reassign Report
                </Button>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
};
