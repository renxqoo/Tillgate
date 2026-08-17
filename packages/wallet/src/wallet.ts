/**
 * 通用资金钱包（两阶段账本，业务无关）——动词装配层。
 * 每个动词一个文件（credit/authorize/settle/release/refund/balance），
 * 共享机制各归其位：account 行锁 / authorizations 寻址 / replay 幂等重放 /
 * validation 词表。资金不变量见 README（DB check 兜底 + 代码保证）。
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { credit } from './credit';
import { authorize } from './authorize';
import { settle } from './settle';
import { release, releaseExpired } from './release';
import { refund } from './refund';
import { balance } from './balance';
import type { Wallet } from './types';

export function createWallet(db: NodePgDatabase): Wallet {
  return {
    credit: (input) => credit(db, input),
    authorize: (input) => authorize(db, input),
    settle: (input) => settle(db, input),
    release: (input) => release(db, input),
    refund: (input) => refund(db, input),
    balance: (userId) => balance(db, userId),
    releaseExpired: (now, limit) => releaseExpired(db, now, limit),
  };
}
