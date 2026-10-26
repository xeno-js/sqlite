import type { Config } from '@libsql/client'
import type {
  DbPlugin,
  Dictionary,
  IConfigurationService,
  IEventHandler,
  IModule,
  IServiceScope,
  Optional,
  SetupAction,
  XenoRegistry,
} from '@xeno-js/core'
import { DbModule, definePlugin, Guards, LoggerModule, TOKENS } from '@xeno-js/core'
import { sql } from 'drizzle-orm'

import { OutboxWorker } from './background.worker'
import { DbSqlLiteClientFactory } from './factory/sqlite.factory'
import { TransactionState } from './transaction-state'
import type { DbContext, DbTransaction } from './types/db-context.types'
import { SqliteUnitOfWork } from './unit-of-work.sqlite'

/**
 * @description This function is a plugin for the Xeno.JS application builder that sets up the PostgreSQL database module.
 * It takes an optional PoolOptions object as a parameter and returns a function that configures the application builder.
 * The returned function adds a new module to the application builder, which is an instance of the DbModule class.
 * The DbModule class is responsible for managing the database connection and providing access to the database client.
 */
export const withSqlite = <
  TRegistry extends XenoRegistry<DbContext, DbTransaction> = XenoRegistry<DbContext, DbTransaction>,
>(
  setupAction?: Optional<
    SetupAction<
      Config & {
        outbox?: {
          enable: boolean
          worker?: boolean
          name?: string | string[]
          handlers?: ((scope: IServiceScope<TRegistry>) => IEventHandler<unknown>)[]
        }
      },
      IConfigurationService
    >
  >,
): DbPlugin<TRegistry> => {
  return definePlugin('db', (builder, config) => {
    const url = config.get('DATABASE_URL', '')!
    const authToken = config.get('DB_AUTH_TOKEN')

    const opts = {
      url,
      authToken,
      concurrency: 50,
    } as Config & {
      outbox?: {
        enable: boolean
        worker?: boolean
        name?: string | string[]
        handlers?: (<T>(scope: IServiceScope<TRegistry>) => IEventHandler<T>)[]
      }
    }

    if (Guards.isDefined(setupAction)) setupAction(opts, config)

    const client = new DbSqlLiteClientFactory().create(opts)

    const dbModule: IModule<TRegistry> = {
      async configure(container) {
        const array = opts.outbox?.name
        if (!Guards.isDefined(array)) return

        const scope = container.createScope()
        try {
          const names = Guards.isArray(array) ? array : [array]
          for (const name of names) {
            const tableName = `${name?.toLowerCase()}_outbox_messages`
            const db = scope.resolve(TOKENS.DB_CONTEXT)

            await db.run(sql`
                            CREATE TABLE IF NOT EXISTS ${sql.identifier(tableName)} (
                                id TEXT PRIMARY KEY,
                                aggregate_id TEXT NOT NULL,
                                aggregate_type TEXT NOT NULL,
                                type TEXT NOT NULL,
                                payload TEXT NOT NULL,
                                status TEXT NOT NULL DEFAULT 'PENDING',
                                version INT NOT NULL,
                                correlation_id TEXT NOT NULL,
                                request_id TEXT,
                                tenant_id TEXT,
                                user_id TEXT,
                                destination TEXT,
                                retry_count INT NOT NULL DEFAULT 0,
                                last_error TEXT,
                                published_at INTEGER,
                                created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INT) * 1000)
                            );
                        `)
          }

          if (Guards.isDefined(opts.outbox?.worker) && opts.outbox?.worker) {
            if (!container.isRegistered(TOKENS.LOGGER)) {
              await new LoggerModule<TRegistry>().configure(container, {
                console: true,
                builder,
                config,
              })
            }

            const db = scope.resolve(TOKENS.DB_CONTEXT)
            container.addSingleton(
              TOKENS.BACKGROUND_WORKER,
              (c) =>
                new OutboxWorker<Dictionary>(
                  db,
                  c.resolve(TOKENS.EVENT_DISPATCHER),
                  c.resolve(TOKENS.LOGGER),
                  names,
                  c.resolve(TOKENS.REQUEST_CONTEXT),
                ),
            )

            if (
              Guards.isDefined(opts.outbox?.handlers) &&
              !Guards.isNullOrEmpty(opts.outbox?.handlers)
            ) {
              const dispatcher = container.resolve(TOKENS.EVENT_DISPATCHER)
              for (const handlerFactory of opts.outbox.handlers) {
                const handler = handlerFactory(container)
                dispatcher.subscribe(handler.eventType, handler)
              }
            }
          }
          console.info('  [SQLite Plugin] Outbox table checked/created successfully.')
        } catch (error) {
          console.error('  [SQLite Plugin] Failed to initialize outbox table:', error)
          throw error
        } finally {
          await scope.dispose()
        }
      },
    }

    if (Guards.isDefined(opts.outbox) && opts.outbox.enable) {
      if (Guards.isNullOrEmpty(opts.outbox.name)) {
        throw new Error(
          'outbox name is required. Please, set outbox.name in your configuration file. The provided name must reflect the name of the aggregate root. (e.g., outbox = {name: "Order"} or outbox = {name: ["Order", "Product"]})',
        )
      }
      builder.addModule('OUTBOX', async () => dbModule, {}, 50)
    }

    const uow =
      Guards.isDefined(opts.outbox) && opts.outbox.enable
        ? (c: IServiceScope<TRegistry>) =>
            new SqliteUnitOfWork(
              c.resolve(TOKENS.DB_CONTEXT),
              new TransactionState(),
              c.resolve(TOKENS.REQUEST_CONTEXT),
            )
        : undefined

    builder.addModule(
      'SqliteDbModule',
      async () => {
        return new DbModule<TRegistry, DbContext, DbTransaction>()
      },
      { client, uow },
      2,
    )
  })
}
