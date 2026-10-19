import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAuditLogsApi } from '../../api/analytics.js';
import { formatDateTime } from '../../lib/format.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { Spinner } from '../../components/Spinner.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Pagination } from '../../components/Pagination.js';
import { FilterBar } from '../../components/FilterBar.js';
import { DataTable, Column } from '../../components/DataTable.js';
import { CopyButton } from '../../components/CopyButton.js';
import { JsonView } from '../../components/JsonView.js';
import type { AuditLogItem } from '../../api/types.js';

export const AdminAuditPage: React.FC = () => {
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [subjectIdFilter, setSubjectIdFilter] = useState('');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');
  const [page, setPage] = useState(1);

  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['admin-audit', page, eventTypeFilter, subjectIdFilter, fromFilter, toFilter],
    queryFn: () =>
      getAuditLogsApi({
        page,
        pageSize: 15,
        eventType: eventTypeFilter.trim() || undefined,
        subjectId: subjectIdFilter.trim() || undefined,
        from: fromFilter ? new Date(fromFilter).toISOString() : undefined,
        to: toFilter ? new Date(toFilter).toISOString() : undefined
      })
  });

  const columns: Column<AuditLogItem>[] = [
    {
      key: 'occurredAt',
      header: 'Timestamp',
      render: (item) => (
        <span className="text-xs text-text-muted whitespace-nowrap">
          {formatDateTime(item.occurredAt)}
        </span>
      )
    },
    {
      key: 'eventType',
      header: 'Event Type',
      render: (item) => (
        <span className="font-mono text-xs font-semibold text-text">{item.eventType}</span>
      )
    },
    {
      key: 'actor',
      header: 'Actor',
      render: (item) => (
        <span className="text-xs font-medium text-text-muted">
          {item.actorId || (item as unknown as { actor?: string }).actor || 'system'}
        </span>
      )
    },
    {
      key: 'subjectId',
      header: 'Subject ID',
      render: (item) => (
        <div className="flex items-center gap-1 font-mono text-xs">
          <span>{item.subjectId ? item.subjectId.substring(0, 8) : '—'}</span>
          {item.subjectId && (
            <CopyButton
              text={item.subjectId}
              label="Copy"
              ariaLabel={`Copy subject ID ${item.subjectId}`}
            />
          )}
        </div>
      )
    },
    {
      key: 'payload',
      header: 'Payload',
      render: (item) => (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setExpandedLogId(expandedLogId === item.id ? null : item.id)}
        >
          {expandedLogId === item.id ? 'Hide' : 'Inspect'}
        </Button>
      )
    }
  ];

  return (
    <div className="flex flex-col gap-6 max-w-6xl mx-auto py-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-text">System Audit Trail</h1>
          <p className="text-sm text-text-muted mt-1">
            Immutable, append-only log of domain events and security state transitions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            loading={isFetching}
          >
            Refresh Logs
          </Button>
        </div>
      </div>

      <FilterBar
        hasActiveFilters={Boolean(eventTypeFilter || subjectIdFilter || fromFilter || toFilter)}
        onClear={() => {
          setEventTypeFilter('');
          setSubjectIdFilter('');
          setFromFilter('');
          setToFilter('');
          setPage(1);
        }}
      >
        <Field
          id="event-type-filter"
          label="Event Type"
          placeholder="e.g. report.status-changed"
          value={eventTypeFilter}
          onChange={(e) => {
            setEventTypeFilter(e.target.value);
            setPage(1);
          }}
        />

        <Field
          id="subject-id-filter"
          label="Subject ID"
          placeholder="Report or User UUID"
          value={subjectIdFilter}
          onChange={(e) => {
            setSubjectIdFilter(e.target.value);
            setPage(1);
          }}
        />

        <Field
          id="date-from-filter"
          label="From Date"
          type="date"
          value={fromFilter}
          onChange={(e) => {
            setFromFilter(e.target.value);
            setPage(1);
          }}
        />

        <Field
          id="date-to-filter"
          label="To Date"
          type="date"
          value={toFilter}
          onChange={(e) => {
            setToFilter(e.target.value);
            setPage(1);
          }}
        />
      </FilterBar>

      {error && (
        <ErrorNotice title="Failed to load audit logs" message={(error as Error).message} />
      )}

      {/* Expanded Log Inspector */}
      {expandedLogId && (
        <div className="p-4 rounded-lg bg-surface border border-border flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-text uppercase">
              Event Details (Log #{expandedLogId.substring(0, 8)})
            </span>
            <Button variant="ghost" size="sm" onClick={() => setExpandedLogId(null)}>
              Close
            </Button>
          </div>
          {(() => {
            const item = data?.items.find((i) => i.id === expandedLogId);
            return item ? <JsonView data={item.payload} initialExpanded /> : null;
          })()}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center items-center py-16" aria-live="polite">
          <Spinner size="lg" label="Loading audit log records..." />
        </div>
      ) : (
        <>
          <DataTable
            columns={columns}
            data={data?.items || []}
            keyExtractor={(item) => item.id}
            emptyMessage="No audit log events match your query."
          />

          {data && data.totalPages > 1 && (
            <div className="flex justify-center pt-4">
              <Pagination
                page={data.page}
                totalPages={data.totalPages}
                onPageChange={(p) => setPage(p)}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
};
