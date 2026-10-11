/**
 * 校准记录保留策略（docs §3.1——结算批后 best-effort 清理）：
 * 移出结算事务（v3-R4：批事务内清理会拉长锁驻留且存在跨批死锁向量）。
 * 幂等 DELETE；失败只打日志不重试（记录是可重建派生事实，I0 安全分离）。
 */
import { CALIBRATION_RECORD_KEEP, type CalibrationStore } from '@tillgate/billing';

/** 结算后对 (user, mapping) 触碰组清理超量旧行（fire-and-forget 面） */
export async function calibrationRetention(
  store: CalibrationStore,
  receipt: { userId?: unknown; mappingId?: unknown },
): Promise<void> {
  const { userId, mappingId } = receipt;
  if (typeof userId !== 'number' || typeof mappingId !== 'number') return;
  await store.cleanup(undefined as never, { userId, mappingId, keep: CALIBRATION_RECORD_KEEP });
}
