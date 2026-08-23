/**
 * 对账差异持久化 port（reconcile_discrepancies 表——db schema 注明写入方为
 * worker 对账作业）。worker 消费：verifyInvariants 发现漂移 → 差异行落表
 * （排障真相）+ 告警入箱（notifications，worker 侧 fire-and-forget）。
 */
export interface ReconcileDiscrepancyRow {
  /** 维度：user / platform / hold（db schema 词表） */
  scope: string;
  userId: number | null;
  expected: string;
  actual: string;
  /** actual − expected */
  diff: string;
  detail: string | null;
}

export interface ReconcileDiscrepancyStore {
  /** 批量写入差异行（自开事务；幂等性由调用方节奏保证——同一漂移重复落表可接受） */
  insertDiscrepancies(rows: readonly ReconcileDiscrepancyRow[]): Promise<number>;
}
