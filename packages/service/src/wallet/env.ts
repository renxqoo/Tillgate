/**
 * wallet 用例族装配契约：进程级 env + 跨动词组事务注入。
 * 动词实现各居一文件，wallet.ts 只做装配组合。
 */
import type { Db, DbTx } from '@ai-gateway/repository';
import type { WalletGuards } from '@ai-gateway/domain';

/** 进程级装配（组合根注入；不出现在调用链） */
export interface WalletEnv {
  db: Db;
  guards: WalletGuards;
  /** 本装配的记账币种（ISO-4217）：调用方未显式传币种时的缺省口径——装配必填，不藏全局默认 */
  currency: string;
  /** 仓储注入（缺省进程级默认实例） */
  repos?: import('@ai-gateway/repository').Repositories;
}

/** 加入调用方共享事务（跨动词组事务，如 billing §4 补充授权） */
export interface TxInjection {
  tx?: DbTx;
}
