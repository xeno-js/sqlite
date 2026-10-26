import type { Dictionary, IEventDispatcher, ILogger, IRequestContext, RequestContext } from '@xeno-js/core';
import { AppError, Result } from '@xeno-js/core';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm', () => ({
    sql: {
        raw: vi.fn((query: string) => query),
    },
}));

import { OutboxWorker } from '../background.worker';
import type { DbContext } from '../types/db-context.types';

interface OutboxMessage {
    id: string;
    type: string;
    payload: unknown;
    [key: string]: unknown;
}

interface TransactionStub {
    all: Mock<(...args: unknown[]) => Promise<OutboxMessage[]>>;
}

type TransactionCallback = <T>(callback: (tx: TransactionStub) => Promise<T>) => Promise<T>;

const message = (overrides: Partial<OutboxMessage> = {}): OutboxMessage => ({
    id: 'message-1',
    type: 'user.created',
    payload: '{"name":"Ada"}',
    ['aggregate_id']: 'aggregate-1',
    ['retry_count']: 0,
    ...overrides,
});

describe('OutboxWorker', () => {
    let transaction: TransactionStub;
    let transact: Mock<TransactionCallback>;
    let db: DbContext<Dictionary>;
    let dispatcher: IEventDispatcher;
    let logger: ILogger;
    let requestContext: IRequestContext<RequestContext>;
    let publish: Mock<IEventDispatcher['publish']>;
    let runAsync: Mock<IRequestContext<RequestContext>['runAsync']>;
    let logInfo: Mock<ILogger['info']>;
    let logError: Mock<ILogger['error']>;

    beforeEach(() => {
        vi.useFakeTimers();
        transaction = { all: vi.fn<(...args: unknown[]) => Promise<OutboxMessage[]>>() };
        transact = vi.fn(async <T>(callback: (tx: TransactionStub) => Promise<T>) => callback(transaction));
        db = {
            transaction: transact,
        } as unknown as DbContext<Dictionary>;
        publish = vi.fn<IEventDispatcher['publish']>().mockResolvedValue(Result.ok());
        dispatcher = {
            publish,
            subscribe: vi.fn<IEventDispatcher['subscribe']>(),
        };
        logInfo = vi.fn<ILogger['info']>();
        logError = vi.fn<ILogger['error']>();
        logger = {
            info: logInfo,
            warn: vi.fn<ILogger['warn']>(),
            error: logError,
            debug: vi.fn<ILogger['debug']>(),
        };
        runAsync = vi.fn(async <T>(_context: RequestContext, callback: () => Promise<T>) => callback());
        requestContext = {
            runAsync,
            updateIdentity: vi.fn<IRequestContext<RequestContext>['updateIdentity']>(),
        } as unknown as IRequestContext<RequestContext>;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('starts only once, logs the configured interval, and stops its polling timer', async () => {
        transaction.all.mockResolvedValue([]);
        const worker = new OutboxWorker(db, dispatcher, logger, ['users'], requestContext);

        worker.start(2500);
        worker.start(1000);
        await vi.waitFor(() => expect(transaction.all).toHaveBeenCalledTimes(1));

        expect(logInfo).toHaveBeenCalledTimes(1);
        expect(logInfo).toHaveBeenCalledWith(
            'SQLite Outbox Worker started. Polling 1 tables every 2500 ms.'
        );

        worker.stop();
        await vi.advanceTimersByTimeAsync(2500);
        expect(transaction.all).toHaveBeenCalledTimes(1);
    });

    it('uses the default polling interval and stops before the next poll', async () => {
        transaction.all.mockResolvedValue([]);
        const worker = new OutboxWorker(db, dispatcher, logger, [], requestContext);

        worker.start();
        await Promise.resolve();

        expect(vi.getTimerCount()).toBe(1);
        expect(logInfo).toHaveBeenCalledWith(
            'SQLite Outbox Worker started. Polling 0 tables every 5000 ms.'
        );

        worker.stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(transact).not.toHaveBeenCalled();
    });

    it('publishes pending messages with parsed payloads and marks them published', async () => {
        transaction.all
            .mockResolvedValueOnce([message()])
            .mockResolvedValueOnce([]);
        const worker = new OutboxWorker(db, dispatcher, logger, ['users'], requestContext);

        worker.start();
        await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
        worker.stop();

        expect(publish).toHaveBeenCalledWith({
            eventType: 'user.created',
            aggregateId: 'aggregate-1',
            payload: { name: 'Ada' },
        });
        expect(runAsync).toHaveBeenCalledTimes(1);
        expect(transaction.all).toHaveBeenCalledTimes(2);
        expect(String(transaction.all.mock.calls[1]?.[0])).toContain("SET status = 'PUBLISHED'");
    });

    it('passes non-string payloads through and marks the message published', async () => {
        const payload = { name: 'Ada' };
        transaction.all
            .mockResolvedValueOnce([message({ payload })])
            .mockResolvedValueOnce([]);
        const worker = new OutboxWorker(db, dispatcher, logger, ['users'], requestContext);

        worker.start();
        await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
        worker.stop();

        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ payload }));
    });

    it.each([
        { retryCount: 0, nextRetryCount: 1, status: 'PENDING' },
        { retryCount: 2, nextRetryCount: 3, status: 'FAILED' },
    ])('increments retries and sets status to $status on dispatch failure', async ({ retryCount, nextRetryCount, status }) => {
        publish.mockResolvedValue(
            Result.fail(AppError.create({
                message: "Couldn't dispatch",
                code: 'DISPATCH_FAILED',
                status: 500,
                name: 'DispatchError',
                cause: undefined,
            }))
        );
        transaction.all
            .mockResolvedValueOnce([message({ ['retry_count']: retryCount })])
            .mockResolvedValueOnce([]);
        const worker = new OutboxWorker(db, dispatcher, logger, ['users'], requestContext);

        worker.start();
        await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
        worker.stop();

        expect(logError).toHaveBeenCalledWith(
            `Outbox routing failed for message-1 (Attempt ${nextRetryCount}):`,
            expect.objectContaining({ message: "Couldn't dispatch" })
        );
        expect(String(transaction.all.mock.calls[1]?.[0])).toContain(`SET status = '${status}'`);
        expect(String(transaction.all.mock.calls[1]?.[0])).toContain(`retry_count = ${nextRetryCount}`);
    });

    it('processes each configured table and skips tables with no pending messages', async () => {
        transaction.all
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([message({ id: 'message-2' })])
            .mockResolvedValueOnce([]);
        const worker = new OutboxWorker(db, dispatcher, logger, ['users', 'orders'], requestContext);

        worker.start();
        await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
        worker.stop();

        expect(transact).toHaveBeenCalledTimes(3);
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ aggregateId: 'aggregate-1' }));
    });

    it('logs database errors and continues processing the next table', async () => {
        transaction.all
            .mockRejectedValueOnce(new Error('database unavailable'))
            .mockResolvedValueOnce([]);
        const worker = new OutboxWorker(db, dispatcher, logger, ['users', 'orders'], requestContext);

        worker.start();
        await vi.waitFor(() => expect(logError).toHaveBeenCalledWith(
            'SQLite Outbox worker error on users_outbox_messages:',
            expect.objectContaining({ message: 'database unavailable' })
        ));
        worker.stop();

        expect(transact).toHaveBeenCalledTimes(2);
        expect(publish).not.toHaveBeenCalled();
    });
});
