import type {
    Dictionary,
    IDomainEvent,
    IRequestContext,
    ITransactionState,
    RequestContext,
} from '@xeno-js/core';
import { AggregateRoot as AggregateRootBase, type OutboxMessage } from '@xeno-js/core';
import { getTableName } from 'drizzle-orm';
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbContext } from '../types/db-context.types';
import { SqliteUnitOfWork } from '../unit-of-work.sqlite';

interface TxStub {
    insert: Mock<(table: AnySQLiteTable) => { values: Mock<(rows: OutboxMessage[]) => { execute: Mock<() => Promise<void>> }> }>;
    rollback?: Mock<() => Promise<void>>;
}

type TransactionCallback = <T>(callback: (tx: TxStub) => Promise<T>) => Promise<T>;

class TestAggregate extends AggregateRootBase<{ name: string }, { name: string }> {
    public appliedEvent: IDomainEvent<{ name: string }> | null = null;

    constructor(withEvent = true) {
        super({ name: 'Ada' }, '11111111-1111-4111-8111-111111111111');
        if (withEvent) {
            this.raise({
                aggregateType: 'TestAggregate',
                eventType: 'test.created',
                payload: { name: 'Ada' },
                destination: 'test-topic',
            });
        }
    }

    protected apply(event: IDomainEvent<{ name: string }>, _isNew: boolean): void {
        this.appliedEvent = event;
    }
}

describe('SqliteUnitOfWork', () => {
    let execute: Mock<() => Promise<void>>;
    let insert: TxStub['insert'];
    let tx: TxStub;
    let transact: Mock<TransactionCallback>;
    let db: DbContext<Dictionary>;
    let state: ITransactionState<DbContext<Dictionary>>;
    let requestContext: IRequestContext<RequestContext>;
    let getContext: Mock<IRequestContext<RequestContext>['getContext']>;
    let context: RequestContext;

    beforeEach(() => {
        execute = vi.fn<() => Promise<void>>().mockResolvedValue();
        insert = vi.fn((table: AnySQLiteTable) => ({
            values: vi.fn((rows: OutboxMessage[]) => {
                expect(getTableName(table)).toBe('testaggregate_outbox_messages');
                expect(rows).toHaveLength(1);
                return { execute };
            }),
        }));
        tx = { insert };
        transact = vi.fn(async <T>(callback: (transaction: TxStub) => Promise<T>) => callback(tx));
        db = { transaction: transact } as unknown as DbContext<Dictionary>;
        state = { state: null };
        context = {
            identity: {
                userId: '11111111-1111-4111-8111-111111111111',
                tenantId: '22222222-2222-4222-8222-222222222222',
            },
            network: {
                requestId: '33333333-3333-4333-8333-333333333333',
                clientIp: '127.0.0.1',
                path: '/test',
                formatIndicator: 'application/json',
            },
            tracing: {
                correlationId: '44444444-4444-4444-8444-444444444444',
                startTime: Date.now(),
                spanId: '55555555-5555-4555-8555-555555555555',
            },
        };
        getContext = vi.fn(() => context);
        requestContext = {
            getContext,
        } as unknown as IRequestContext<RequestContext>;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('runs the callback inside the database transaction, exposes the active transaction, and clears state', async () => {
        const resultValue = { saved: true };
        const unitOfWork = new SqliteUnitOfWork(db, state, requestContext);
        let callbackTransaction: DbContext<Dictionary> | undefined;

        const result = await unitOfWork.runInTransaction(async (transaction) => {
            callbackTransaction = transaction;
            expect(state.state).toBe(tx);
            return resultValue;
        });

        expect(transact).toHaveBeenCalledTimes(1);
        expect(callbackTransaction).toBe(tx);
        expect(result).toBe(resultValue);
        expect(state.state).toBeNull();
        expect(insert).not.toHaveBeenCalled();
    });

    it('clears transaction state when the callback rejects and propagates the error', async () => {
        const unitOfWork = new SqliteUnitOfWork(db, state, requestContext);
        const callbackError = new Error('callback failed');

        await expect(unitOfWork.runInTransaction(async () => {
            throw callbackError;
        })).rejects.toBe(callbackError);

        expect(state.state).toBeNull();
        expect(insert).not.toHaveBeenCalled();
    });

    it('rejects an aborted signal without opening a transaction', async () => {
        const unitOfWork = new SqliteUnitOfWork(db, state, requestContext);
        const controller = new AbortController();
        controller.abort();

        await expect(unitOfWork.runInTransaction(async () => 'unreachable', undefined, controller.signal))
            .rejects.toThrow();

        expect(transact).not.toHaveBeenCalled();
        expect(state.state).toBeNull();
    });

    it('writes uncommitted aggregate events to the outbox and clears them after insertion', async () => {
        const aggregate = new TestAggregate();
        const unitOfWork = new SqliteUnitOfWork(db, state, requestContext);

        await unitOfWork.runInTransaction(async () => 'done', aggregate);

        expect(insert).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(aggregate.getUncommittedEvents()).toHaveLength(0);
        expect(state.state).toBeNull();
    });

    it('handles an aggregate list, skips aggregates without events, and uses generated context when absent', async () => {
        getContext.mockReturnValue(undefined);
        const noEventAggregate = new TestAggregate(false);
        const aggregate = new TestAggregate();
        const unitOfWork = new SqliteUnitOfWork(db, state, requestContext);

        await unitOfWork.runInTransaction(async () => 'done', [noEventAggregate, aggregate]);

        expect(insert).toHaveBeenCalledTimes(1);
        expect(aggregate.getUncommittedEvents()).toHaveLength(0);
        expect(noEventAggregate.getUncommittedEvents()).toHaveLength(0);
    });

    it('does not clear aggregate events if outbox insertion fails', async () => {
        execute.mockRejectedValueOnce(new Error('outbox insert failed'));
        const aggregate = new TestAggregate();
        const unitOfWork = new SqliteUnitOfWork(db, state, requestContext);

        await expect(unitOfWork.runInTransaction(async () => 'done', aggregate))
            .rejects.toThrow('outbox insert failed');

        expect(aggregate.getUncommittedEvents()).toHaveLength(1);
        expect(state.state).toBeNull();
    });

    it('rolls back an active transaction during disposal and always clears its state', async () => {
        const rollback = vi.fn<() => Promise<void>>().mockResolvedValue();
        const activeTransaction = { rollback };
        state = { state: activeTransaction } as unknown as ITransactionState<DbContext<Dictionary>>;
        const unitOfWork = new SqliteUnitOfWork(db, state, requestContext);

        await unitOfWork.dispose();

        expect(rollback).toHaveBeenCalledTimes(1);
        expect(state.state).toBeNull();
    });

    it('clears transaction state when rollback during disposal fails', async () => {
        const rollbackError = new Error('rollback failed');
        const rollback = vi.fn<() => Promise<void>>().mockRejectedValue(rollbackError);
        state = { state: { rollback } } as unknown as ITransactionState<DbContext<Dictionary>>;
        const unitOfWork = new SqliteUnitOfWork(db, state, requestContext);

        await expect(unitOfWork.dispose()).rejects.toBe(rollbackError);

        expect(rollback).toHaveBeenCalledTimes(1);
        expect(state.state).toBeNull();
    });

    it('does nothing when no transaction is active and clears state when rollback is unavailable', async () => {
        const unitOfWork = new SqliteUnitOfWork(db, state, requestContext);

        await unitOfWork.dispose();
        expect(state.state).toBeNull();

        const activeTransaction = {};
        state = { state: activeTransaction } as unknown as ITransactionState<DbContext<Dictionary>>;
        const secondUnitOfWork = new SqliteUnitOfWork(db, state, requestContext);

        await secondUnitOfWork.dispose();
        expect(state.state).toBeNull();
    });
});
