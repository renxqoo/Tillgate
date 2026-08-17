/**
 * 通用资金钱包（复式账本，业务无关）——动词装配层。
 * 每个动词一个文件；复式模型：每笔资金交易 = 批头（幂等键）+ ≥2 腿（Σ=0）。
 * credit/settle/refund 自动生成对手腿（内部科目）；transfer 原子转账；
 * freeze 风控冻结。资金不变量见 README（DB check 兜底 + 代码保证 + 对账测试）。
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { credit } from './credit';
import { authorize } from './authorize';
import { settle } from './settle';
import { release, releaseExpired } from './release';
import { refund } from './refund';
import { transfer } from './transfer';
import { setCreditLimit } from './credit-line';
import { freeze } from './freeze';
import { accounts, balance } from './balance';
import { statement } from './statement';
import type { Wallet } from './types';

export function createWallet(db: NodePgDatabase): Wallet {
  return {
    credit: (input) => credit(db, input),
    authorize: (input) => authorize(db, input),
    settle: (input) => settle(db, input),
    release: (input) => release(db, input),
    refund: (input) => refund(db, input),
    transfer: (input) => transfer(db, input),
    setCreditLimit: (input) => setCreditLimit(db, input),
    freeze: (input) => freeze(db, input),
    balance: (userId, currency) => balance(db, userId, currency),
    accounts: (userId) => accounts(db, userId),
    statement: (input) => statement(db, input),
    releaseExpired: (now, limit) => releaseExpired(db, now, limit),
  };
}
