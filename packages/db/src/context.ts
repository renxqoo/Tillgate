/**
 * db 会话类型:事务句柄(写路径,用例层持有并注入)或池句柄(只读路径)的统一参数型。
 * v1 散落在 repository/wallet/ledger-core/identity-core 的四种变体收敛于此(D4)。
 */
import type { Db, DbTx } from './client.js';

export type DbLike = Db | DbTx;
