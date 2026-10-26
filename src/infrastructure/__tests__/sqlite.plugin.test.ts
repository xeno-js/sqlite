import { DbModule, TOKENS } from '@xeno-js/core';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SqliteUnitOfWork } from '../unit-of-work.sqlite';

const { createClient } = vi.hoisted(() => ({
    createClient: vi.fn(),
}));

vi.mock('../factory/sqlite.factory', () => ({
    DbSqlLiteClientFactory: class {
        public create = createClient;
    },
}));

import { withSqlite } from '../sqlite.plugin';

type Setup = NonNullable<Parameters<typeof withSqlite>[0]>;
type Plugin = ReturnType<typeof withSqlite>;
type PluginBuilder = Parameters<Plugin>[0];
type PluginConfig = Parameters<Plugin>[1];
type Configure = (container: ContainerStub) => Promise<void>;

interface RegisteredModule {
    name: string;
    factory: () => Promise<unknown>;
    options: unknown;
    priority: number | undefined;
}

type AddModule = (name: string, factory: () => Promise<unknown>, options?: unknown, priority?: number) => RegisteredModule;

interface ContainerStub {
    createScope: Mock<() => ScopeStub>;
    isRegistered: Mock<(token: unknown) => boolean>;
    addSingleton: Mock<(token: unknown, factory: (scope: ScopeStub) => unknown) => unknown>;
    resolve: Mock<(token: unknown) => unknown>;
}

interface ScopeStub {
    resolve: Mock<(token: unknown) => unknown>;
    dispose: Mock<() => Promise<void>>;
}

interface ModuleStub {
    configure: Configure;
}

const createHarness = (setup?: Setup) => {
    createClient.mockReset();
    createClient.mockReturnValue({ client: 'sqlite-client' });
    const registeredModules: RegisteredModule[] = [];
    const addModule = vi.fn<AddModule>((name, factory, options, priority) => {
        const registeredModule = { name, factory, options, priority };
        registeredModules.push(registeredModule);
        return registeredModule;
    });
    const getConfig = vi.fn((key: string, defaultValue?: string) => {
        if (key === 'DATABASE_URL') return 'file:unit-test.db';
        if (key === 'DB_AUTH_TOKEN') return 'auth-token';
        return defaultValue;
    });
    const config = { get: getConfig } as unknown as PluginConfig;
    const builder = { addModule } as unknown as PluginBuilder;
    const plugin = withSqlite(setup);

    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const modules = (): RegisteredModule[] => registeredModules;

    return { addModule, builder, config, createClient, getConfig, modules, plugin };
};

const createContainer = (db = { run: vi.fn().mockResolvedValue(undefined) }) => {
    const scope: ScopeStub = {
        resolve: vi.fn(() => db),
        dispose: vi.fn<() => Promise<void>>().mockResolvedValue(),
    };
    const container: ContainerStub = {
        createScope: vi.fn(() => scope),
        isRegistered: vi.fn(() => true),
        addSingleton: vi.fn(),
        resolve: vi.fn(),
    };
    return { container, db, scope };
};

const configureModule = async (registered: RegisteredModule, container: ContainerStub): Promise<void> => {
    const module = await registered.factory() as ModuleStub;
    await module.configure(container);
};

describe('withSqlite', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('creates the SQLite client from configuration and always registers the database module', async () => {
        const setupAction = vi.fn<Setup>((options) => {
            expect(options.url).toBe('file:unit-test.db');
            expect(options.authToken).toBe('auth-token');
            expect(options.concurrency).toBe(50);
        });
        const harness = createHarness(setupAction);

        await harness.plugin(harness.builder, harness.config);

        expect(setupAction).toHaveBeenCalledTimes(1);
        expect(harness.getConfig).toHaveBeenCalledWith('DATABASE_URL', '');
        expect(harness.getConfig).toHaveBeenCalledWith('DB_AUTH_TOKEN');
        expect(createClient).toHaveBeenCalledWith({
            url: 'file:unit-test.db',
            authToken: 'auth-token',
            concurrency: 50,
        });
        expect(harness.addModule).toHaveBeenCalledTimes(1);

        const [dbModule] = harness.modules();
        expect(dbModule?.name).toBe('SqliteDbModule');
        expect(dbModule?.priority).toBe(2);
        expect(dbModule?.options).toEqual({
            client: { client: 'sqlite-client' },
            uow: undefined,
        });
        await expect(dbModule?.factory()).resolves.toBeInstanceOf(DbModule);
    });

    it('uses default SQLite options when no setup action is provided', async () => {
        const harness = createHarness();

        await harness.plugin(harness.builder, harness.config);

        expect(createClient).toHaveBeenCalledWith({
            url: 'file:unit-test.db',
            authToken: 'auth-token',
            concurrency: 50,
        });
        expect(harness.modules()).toHaveLength(1);
    });

    it('registers the outbox module and unit-of-work factory when outbox is enabled', async () => {
        const harness = createHarness((options) => {
            options.outbox = { enable: true, name: 'Order' };
        });

        await harness.plugin(harness.builder, harness.config);

        const modules = harness.modules();
        expect(modules.map(({ name, priority }) => ({ name, priority }))).toEqual([
            { name: 'OUTBOX', priority: 50 },
            { name: 'SqliteDbModule', priority: 2 },
        ]);
        const dbOptions = modules[1]?.options as { client: unknown; uow: unknown };
        expect(dbOptions.client).toEqual({ client: 'sqlite-client' });
        expect(dbOptions.uow).toBeTypeOf('function');
        const scope = {
            resolve: vi.fn((token: unknown) => token === TOKENS.DB_CONTEXT ? {} : {}),
        } as unknown as ScopeStub;
        const createUnitOfWork = dbOptions.uow as (serviceScope: ScopeStub) => unknown;
        expect(createUnitOfWork(scope)).toBeInstanceOf(SqliteUnitOfWork);
    });

    it.each([undefined, '', []])('rejects enabled outbox configuration without a name (%s)', async (name) => {
        const harness = createHarness((options) => {
            options.outbox = { enable: true, name };
        });

        expect(() => harness.plugin(harness.builder, harness.config))
            .toThrow('outbox name is required.');
        expect(harness.addModule).not.toHaveBeenCalled();
    });

    it('creates each configured outbox table for a list of names and disposes the scope', async () => {
        const harness = createHarness((options) => {
            options.outbox = { enable: true, name: ['Order', 'Product'] };
        });
        await harness.plugin(harness.builder, harness.config);
        const { container, db, scope } = createContainer();

        await configureModule(harness.modules()[0], container);

        expect(container.createScope).toHaveBeenCalledTimes(1);
        expect(db.run).toHaveBeenCalledTimes(2);
        expect(scope.resolve).toHaveBeenCalledTimes(2);
        expect(scope.dispose).toHaveBeenCalledTimes(1);
        expect(console.info).toHaveBeenCalledWith('  [SQLite Plugin] Outbox table checked/created successfully.');
    });

    it('accepts one outbox name and creates its table', async () => {
        const harness = createHarness((options) => {
            options.outbox = { enable: true, name: 'Order' };
        });
        await harness.plugin(harness.builder, harness.config);
        const { container, db, scope } = createContainer();

        await configureModule(harness.modules()[0], container);

        expect(db.run).toHaveBeenCalledTimes(1);
        expect(scope.dispose).toHaveBeenCalledTimes(1);
    });

    it('skips outbox initialization if the configured name is later removed', async () => {
        const captured: { options?: Parameters<Setup>[0] } = {};
        const harness = createHarness((options) => {
            captured.options = options;
            options.outbox = { enable: true, name: 'Order' };
        });
        await harness.plugin(harness.builder, harness.config);
        const options = captured.options;
        if (options === undefined) {
            throw new Error('Setup options were not captured');
        }
        options.outbox = { enable: true };
        const { container } = createContainer();

        const outboxModule = harness.modules()[0];
        if (outboxModule === undefined) {
            throw new Error('Outbox module was not registered');
        }
        await configureModule(outboxModule, container);

        expect(container.createScope).not.toHaveBeenCalled();
    });

    it('registers an outbox worker and subscribes handlers when worker support is enabled', async () => {
        const handler = { eventType: 'order.created', handle: vi.fn() };
        const handlerFactory = vi.fn(() => handler);
        const harness = createHarness((options) => {
            options.outbox = { enable: true, worker: true, name: 'Order', handlers: [handlerFactory] };
        });
        await harness.plugin(harness.builder, harness.config);
        const dispatcher = { subscribe: vi.fn() };
        const { container, db, scope } = createContainer();
        container.isRegistered.mockReturnValue(true);
        container.resolve.mockReturnValue(dispatcher);

        await configureModule(harness.modules()[0], container);

        expect(container.addSingleton).toHaveBeenCalledWith(
            TOKENS.BACKGROUND_WORKER,
            expect.any(Function)
        );
        const singletonRegistration = container.addSingleton.mock.calls[0];
        const workerFactory = singletonRegistration?.[1];
        if (workerFactory === undefined) {
            throw new Error('Background worker factory was not registered');
        }
        workerFactory({
            resolve: container.resolve,
            dispose: vi.fn<() => Promise<void>>().mockResolvedValue(),
        });
        expect(handlerFactory).toHaveBeenCalledWith(container);
        expect(dispatcher.subscribe).toHaveBeenCalledWith('order.created', handler);
        expect(scope.resolve).toHaveBeenCalledTimes(2);
        expect(db.run).toHaveBeenCalledTimes(1);
    });

    it('registers the default logger when worker setup requires it', async () => {
        const harness = createHarness((options) => {
            options.outbox = { enable: true, worker: true, name: 'Order' };
        });
        await harness.plugin(harness.builder, harness.config);
        const { container } = createContainer();
        container.isRegistered.mockReturnValue(false);

        await configureModule(harness.modules()[0], container);

        expect(container.addSingleton).toHaveBeenCalled();
    });

    it('logs and rethrows initialization errors while disposing the scope', async () => {
        const harness = createHarness((options) => {
            options.outbox = { enable: true, name: 'Order' };
        });
        await harness.plugin(harness.builder, harness.config);
        const failure = new Error('outbox setup failed');
        const { container, db, scope } = createContainer({
            run: vi.fn().mockRejectedValue(failure),
        });

        await expect(configureModule(harness.modules()[0], container)).rejects.toBe(failure);

        expect(console.error).toHaveBeenCalledWith(
            '  [SQLite Plugin] Failed to initialize outbox table:',
            failure
        );
        expect(scope.dispose).toHaveBeenCalledTimes(1);
        expect(db.run).toHaveBeenCalledTimes(1);
    });

    it('propagates scope disposal failures after successful table setup', async () => {
        const harness = createHarness((options) => {
            options.outbox = { enable: true, name: 'Order' };
        });
        await harness.plugin(harness.builder, harness.config);
        const disposalError = new Error('scope dispose failed');
        const { container, scope } = createContainer();
        scope.dispose.mockRejectedValueOnce(disposalError);

        await expect(configureModule(harness.modules()[0], container)).rejects.toBe(disposalError);
        expect(console.info).toHaveBeenCalled();
    });
});
