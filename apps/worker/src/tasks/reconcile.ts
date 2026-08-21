/**
 * 周期对账哨兵：wallet 复式账本不变量核验
 * （balance=Σ流水、in_flight=Σ活跃冻结等——packages/wallet maintenance 单一真相）。
 * 不平 → reconcile_discrepancy 告警入箱（每小时一次 dedupe）+ error 日志。
 *
 * 定位：即使上游机制有 bug，对账也是最后发现资损的哨兵；
 * advisory lock 保证多副本只跑一份。
 */
import { createWalletMaintenance } from '@ai-gateway/wallet/maintenance';
import type { Db } from '@ai-gateway/repository';
import { notifyOutbox } from '@ai-gateway/db';

export async function runReconcileOnce(
  db: Db,
  logger: { error(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void },
): Promise<{ discrepancies: number }> {
  const client = await db.$client.connect();
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext('ai-gateway:billing-reconcile')) as acquired",
    );
    if (!lock.rows[0]?.acquired) return { discrepancies: 0 };
    try {
      const report = await createWalletMaintenance(db as never).verifyInvariants();
      const discrepancies = report.violations.length;
      if (discrepancies > 0) {
        logger.error({ discrepancies }, 'reconciliation discrepancies');
        await db
          .insert(notifyOutbox)
          .values({
            event: 'reconcile_discrepancy',
            payload: { discrepancies },
            dedupeKey: `reconcile-discrepancy:${new Date().toISOString().slice(0, 13)}`,
          })
          .onConflictDoNothing()
          .catch(() => undefined);
      }
      return { discrepancies };
    } finally {
      await client.query("select pg_advisory_unlock(hashtext('ai-gateway:billing-reconcile'))");
    }
  } catch (error) {
    logger.warn({ err: (error as Error).message }, 'reconcile failed');
    return { discrepancies: 0 };
  } finally {
    client.release();
  }
}
