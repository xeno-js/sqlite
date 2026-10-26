/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const createOutboxTable = (tableName = 'default') => {
    return sqliteTable(`${tableName.toLowerCase()}_outbox_messages`, {
        id: text('id').primaryKey(),
        aggregateId: text('aggregate_id').notNull(),
        aggregateType: text('aggregate_type').notNull(),
        type: text('type').notNull(),

        payload: text('payload', { mode: 'json' }).notNull(),

        status: text('status').notNull().default('PENDING'),
        version: integer('version').notNull(),
        correlationId: text('correlation_id').notNull(),
        requestId: text('request_id'),
        tenantId: text('tenant_id'),
        userId: text('user_id'),
        destination: text('destination'),
        retryCount: integer('retry_count').notNull().default(0),
        lastError: text('last_error'),

        publishedAt: integer('published_at', { mode: 'timestamp' }),
        createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    });
};