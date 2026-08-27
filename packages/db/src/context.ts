/**
 * db 会话类型:事务句柄(写路径,用例层持有并注入)或池句柄(只读路径)的统一参数型。
 */
import type { Db, DbTx } from './client.js';

export type DbLike = Db | DbTx;
