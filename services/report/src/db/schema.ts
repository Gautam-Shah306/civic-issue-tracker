import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  integer,
  doublePrecision,
  bigserial,
  jsonb,
  primaryKey
} from 'drizzle-orm/pg-core';

export const categories = pgTable('categories', {
  slug: varchar('slug', { length: 50 }).primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  active: boolean('active').notNull().default(true)
});

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  reporterId: uuid('reporter_id').notNull(),
  title: varchar('title', { length: 120 }).notNull(),
  description: varchar('description', { length: 2000 }).notNull(),
  categorySlug: varchar('category_slug', { length: 50 })
    .notNull()
    .references(() => categories.slug),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  address: varchar('address', { length: 300 }),
  status: text('status').notNull().default('Submitted'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const statusHistory = pgTable('status_history', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  reportId: uuid('report_id')
    .notNull()
    .references(() => reports.id, { onDelete: 'cascade' }),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  reasonCode: text('reason_code'),
  note: text('note'),
  changedBy: text('changed_by').notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow()
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id').notNull(),
    key: varchar('key', { length: 255 }).notNull(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })]
);

export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull().unique(),
  eventType: varchar('event_type', { length: 128 }).notNull(),
  version: integer('version').notNull().default(1),
  correlationId: uuid('correlation_id').notNull(),
  payload: jsonb('payload').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true })
});

export const processedEvents = pgTable(
  'processed_events',
  {
    eventId: uuid('event_id').notNull(),
    consumer: varchar('consumer', { length: 64 }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.eventId, table.consumer] })]
);
