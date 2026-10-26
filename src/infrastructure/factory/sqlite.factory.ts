import type { Config } from '@libsql/client'
import { createClient } from '@libsql/client'
import type { Dictionary, IFactory } from '@xeno-js/core'
import { Guards } from '@xeno-js/core'
import { drizzle } from 'drizzle-orm/libsql'

import type { DbContext } from '../types/db-context.types'

/**
 * @description Factory class responsible for creating instances of IDbClient based on the provided configuration. It implements the IFactory interface, allowing for easy integration with dependency injection systems. The factory encapsulates the creation logic for the IDbClient, including the initialization of the underlying database client with the specified configuration options such as connection string and table mappings. This design promotes separation of concerns and allows for flexibility in managing IDbClient instances across the application.
 *
 * @author Xeno
 * @version 1.0.0
 * @since 2025-09-30
 * @link https://github.com/xeno-js/xeno-js
 */
export class DbSqlLiteClientFactory implements IFactory<Config, DbContext<Dictionary>> {
    public create(opts: Config): DbContext<Dictionary> {
        if(Guards.isNullOrEmpty(opts.url))
            throw new Error('DATABASE_URL is required')

        const client = createClient(opts)

        if (opts.url.startsWith('file:')) {
            client.execute('PRAGMA journal_mode = WAL;').catch((err: unknown) => { console.error(err) })
            client.execute('PRAGMA synchronous = NORMAL;').catch((err: unknown) => { console.error(err) })
            client.execute('PRAGMA busy_timeout = 5000;').catch((err: unknown) => { console.error(err) })
        }

        return drizzle({ client })
    }
}