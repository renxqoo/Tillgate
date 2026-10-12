/**
 * 结算侧校准写入（settle.ts 拆出——文件行数棘轮；docs §3.1 写侧 + §2.2 C7）。
 * P7：mappingId 记实际服务映射（收据值——fallback 记 fallback 的）；
 * P10：写入在结算事务提交后独立执行（共享 tx 上语句级错误会毒化整事务——
 * 25P02 aborted，catch 救不了 COMMIT；记录可重建，I0 安全分离）。
 */
import type { CalibrationStore } from '../../ports/calibration-store.js';
import type { UsageReceipt } from '../../domain/rating/types.js';
import type { SettleEnv } from './settle.js';

/**
 * 结算侧组装校准写入输入（docs §3.1 写侧 + §2.2 C7）：
 * quote.calibration 的**前缀事实**（守卫通过即携带——冷启动闭环：写入不依赖
 * 本请求命中）+ 收据实测 inputTokens/channelId。C7b 物理下限（seen ≥
 * prefixBytes/4）镜像判定（语义单源注释互指 inference/calibration.ts）。
 * 返回 null = 不写（非 chat 族/估算收据/零钳制失败均在上游已排除）。
 */
export function calibrationWriteOf(
  billing: { userId: number; quote: Record<string, unknown> },
  receipt: UsageReceipt,
  now: Date,
): Parameters<CalibrationStore['upsert']>[1] | null {
  const calib = billing.quote.calibration as Record<string, unknown> | undefined;
  if (calib == null || typeof calib !== 'object') return null;
  const { prefixHash, messagesLen, prefixBytes } = calib as {
    prefixHash?: unknown;
    messagesLen?: unknown;
    prefixBytes?: unknown;
  };
  // P7（docs §2.4）：mappingId 记实际服务映射（收据值）——fallback 记 fallback 的
  const { mappingId: actualMappingId } = receipt;
  // 写入键 = 前缀事实（messagesLen=本请求全链长、hash=本请求全链哈希）——
  // 下一笔同前缀在此处匹配；C7b 用同前缀字节。
  const { channelId = null } = receipt;
  const { inputTokens } = receipt.usage;
  if (
    typeof actualMappingId !== 'number' ||
    typeof prefixHash !== 'string' ||
    typeof messagesLen !== 'number' ||
    typeof prefixBytes !== 'number' ||
    channelId == null
  ) {
    return null;
  }
  // C7b/7c 守卫（inference 纯函数镜像判定——billing 不依赖 inference，语义单源注释互指）
  if (!Number.isSafeInteger(inputTokens) || inputTokens <= 0) return null;
  if (inputTokens < Math.ceil(prefixBytes / 6)) return null; // C7b（中文负载下界——见头注释）
  return {
    userId: billing.userId,
    mappingId: actualMappingId,
    prefixHash,
    channelId,
    inputTokens,
    messagesLen,
    requestId: receipt.requestId,
    now,
  };
}

/** 校准写入（结算事务提交后独立执行——P10 毒化隔离；失败丢弃可重建） */
export async function writeCalibrationRecord(
  env: SettleEnv,
  input: Parameters<CalibrationStore['upsert']>[1],
): Promise<void> {
  if (env.calibrations == null) return;
  try {
    await env.calibrations.upsert(undefined as never, input);
  } catch {
    // 派生事实：丢弃（下一笔回落保守，非资损）
  }
}
