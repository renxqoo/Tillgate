/**
 * 对账核验（只读哨兵；迁移自旧仓 wallet 引擎 maintenance.verifyInvariants——
 * D9 唯一存活者，MIGRATION-U1 §2）：worker 周期调用，违反 = 资金事实漂移。
 * 纯 SELECT 三类漂移：transaction_balance（Σ腿/腿数）/ account_balance（余额=末腿）/
 * in_flight（在途=Σactive 冻结）。差异告警的入箱是消费方（worker）职责，billing 不拥有通知副作用。
 * 「单副本执行」的 advisory lock 同样在 worker 消费方（DESIGN §4.2）——本用例只读，
 * 不自带锁；多副本并发调用只是重复读，不产生资金风险。
 */
import type { WalletStore } from '../../ports/wallet-store.js';

export interface ReconcileViolation {
  kind: 'transaction_balance' | 'account_balance' | 'in_flight';
  key: string;
  detail: string;
}

export interface ReconcileReport {
  ok: boolean;
  checkedAt: Date;
  violations: ReconcileViolation[];
}

export function createReconcileUseCase(env: {
  walletStore: WalletStore;
  limit?: number;
  /** 时钟（装配必填——报告时间戳不读系统时钟，铁律 3） */
  clock: () => Date;
}) {
  const limit = Math.min(env.limit ?? 1000, 10_000);
  const { clock } = env;
  return async function verifyInvariants(): Promise<ReconcileReport> {
    const violations = await env.walletStore.verifyInvariants(limit);
    return { ok: violations.length === 0, checkedAt: clock(), violations };
  };
}
