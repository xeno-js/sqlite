/* eslint-disable @typescript-eslint/no-misused-promises */
/* eslint-disable @typescript-eslint/naming-convention*/
import type { Dictionary, IBackgroundWorker, IEventDispatcher, ILogger, IRequestContext, RequestContext } from '@xeno-js/core';
import { Guards, GuidHelper, StringHelper } from '@xeno-js/core';
import { sql } from 'drizzle-orm';

import type { DbContext } from './types/db-context.types';

interface OutboxMessageRow {
    id: string;
    type: string;
    payload: unknown;
    aggregate_id: string;
    retry_count: number;
}

export class OutboxWorker<Schema extends Dictionary> implements IBackgroundWorker {
    private _isRunning = false;
    private _timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly _db: DbContext<Schema>,
        private readonly _dispatcher: IEventDispatcher,
        private readonly _logger: ILogger,
        private readonly _tableNames: string[],
        private readonly _requestContext: IRequestContext<RequestContext>
    ) { }

    public start(intervalMs = 5000): void {
        if (this._isRunning) return;
        this._isRunning = true;
        this._logger.info(`SQLite Outbox Worker started. Polling ${this._tableNames.length} tables every ${intervalMs} ms.`);

        const pollLoop = async (): Promise<void> => {
            if (!this._isRunning) return;
            await this.processOutbox();
            if (this._isRunning) { this._timer = setTimeout(pollLoop, intervalMs); }
        };

        void pollLoop();
    }

    public stop(): void {
        this._isRunning = false;
        if (Guards.isDefined(this._timer)) clearInterval(this._timer);
    }

    private async processOutbox(): Promise<void> {
        for (const name of this._tableNames) {
            const tableName = `${name}_outbox_messages`;
            await this.processTable(tableName);
        }
    }

    private async processTable(tableName: string): Promise<void> {
        try {
            const messages = await this._db.transaction(async (tx) => {
                const result = await tx.all<OutboxMessageRow>(sql.raw(`
                    UPDATE ${tableName}
                    SET status = 'PROCESSING'
                    WHERE id IN (
                        SELECT id FROM ${tableName}
                        WHERE status = 'PENDING'
                        ORDER BY created_at ASC
                        LIMIT 50
                    )
                    RETURNING id, type, payload, aggregate_id, retry_count
                `));
                return result;
            });

            if (Guards.isNullOrEmpty(messages)) return;

            for (const row of messages) {
                const messageId = String(row["id"]);
                const retryCount = Number(row["retry_count"] ?? 0);

                const event = {
                    eventType: String(row["type"]),
                    aggregateId: String(row["aggregate_id"]),
                    payload: Guards.isString(row["payload"]) ? StringHelper.safeParse(row["payload"]) : row["payload"],
                };

                const syntheticContext: RequestContext = {
                    identity: { userId: undefined, tenantId: undefined },
                    network: {
                        requestId: GuidHelper.generate(),
                        clientIp: '127.0.0.1',
                        path: 'internal://sqlite-outbox-worker',
                        formatIndicator: 'application/json',
                    },
                    tracing: {
                        correlationId: GuidHelper.generate(),
                        startTime: Date.now(),
                        spanId: GuidHelper.generate(),
                    },
                };

                const result = await this._requestContext.runAsync(syntheticContext, async () => {
                    return await this._dispatcher.publish(event);
                });

                await this._db.transaction(async (tx) => {
                    if (result.isOk()) {
                        await tx.all(sql.raw(`
                            UPDATE ${tableName}
                            SET status = 'PUBLISHED',
                                published_at = strftime('%s', 'now') * 1000
                            WHERE id = '${messageId}'
                        `));
                    } else {
                        const errorMsg = String(result.getErrorOrThrow().message ?? 'Unknown error').replace(/'/g, "''");
                        const newRetryCount = retryCount + 1;
                        const newStatus = newRetryCount >= 3 ? 'FAILED' : 'PENDING';

                        await tx.all(sql.raw(`
                            UPDATE ${tableName}
                            SET status = '${newStatus}',
                                retry_count = ${newRetryCount},
                                last_error = '${errorMsg}'
                            WHERE id = '${messageId}'
                        `));

                        this._logger.error(`Outbox routing failed for ${messageId} (Attempt ${newRetryCount}):`, result.getErrorOrThrow());
                    }
                });
            }
        }
        catch (error) {
            this._logger.error(`SQLite Outbox worker error on ${tableName}:`, error);
        }
    }
}