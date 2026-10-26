import type { Dictionary, ITransactionState, Maybe } from "@xeno-js/core"

import type { DbContext } from './types/db-context.types'

/**
 * @file transaction-state.ts
 * @description This file contains the definition of the TransactionState class.
 * @version 1.0.0
 * @author Xeno
 * @since 2025-09-30
 * @link https://github.com/xeno-js/xeno-js
 */
export class TransactionState<Schema extends Dictionary = Dictionary> implements ITransactionState<DbContext<Schema>> {
    /**
     * The current state of the transaction, which can be either a specific transaction type or null.
     * @author Xeno
     * @version 1.0.0
     * @since 2025-09-30
     * @link https://github.com/xeno-js/xeno-js
     */
    private _state: Maybe<DbContext<Schema>> = null

    /**
     * Creates an instance of TransactionState.
     * @param initialState - The initial state of the transaction, which can be either a specific transaction type or null.
     * @author Xeno
     * @version 1.0.0
     * @since 2025-09-30
     * @link https://github.com/xeno-js/xeno-js
     */
    constructor(initialState: Maybe<DbContext<Schema>> = null) {
        this._state = initialState
    }

    get state(): Maybe<DbContext<Schema>> {
        return this._state
    }

    set state(value: Maybe<DbContext<Schema>>) {
        this._state = value
    }
}
