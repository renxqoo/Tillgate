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
 * 本请求命中）+ 收据实测 inputTokens/channelId。
 *
 * C7b 密度下限已删除（2026-10-13 三路对抗审查裁决；两轮生产事故：÷4 误杀
 * 中文 4.23B/token、÷6 误杀代码混合 6.63B/token——内容字节密度无上界，
 * 任何静态阈值必被某类真实内容击穿）。删除论证 = 故障半径不对称：低报值的
 * 损害已被结算侧三件套兜住且一笔同键 upsert 自愈——① B4② 容错区间（单笔
 * 界：实际成本 ≤ conservative_channel_amount 按实际扣，超则死信）；② 渠道
 * 预算熔断（总量界：扣后 budget ≤ threshold 即熔断）；③ debit_floor（账号
 * 界：over 补扣钳「可用+地板」，超出 waived）。而守卫自身的失败模式是全局
 * 断粮（校准表空 → 保守口径 → 渠道预算闸 503）。C7c 类型检查保留（防代码
 * 炸，非防伪）。
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
  // 下一笔同前缀在此处匹配；prefixBytes 保留作密度观测轴（非门禁）。
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
  // C7c 类型检查（防代码炸——零/负/非整数会让下游预估产生非法边界）。
  // C7b 密度下限已删（见函数头）；低报值防线在结算侧三件套。
  if (!Number.isSafeInteger(inputTokens) || inputTokens <= 0) return null;
  return {
    userId: billing.userId,
    mappingId: actualMappingId,
    prefixHash,
    channelId,
    inputTokens,
    messagesLen,
    prefixBytes,
    requestId: receipt.requestId,
    now,
  };
}

/** 密度桶（观测粒度——非行为阈值；<1 B/tok 即低报中转的强信号） */
function densityBucket(bytesPerToken: number): string {
  if (bytesPerToken < 1) return 'lt1';
  if (bytesPerToken < 4) return '1-4';
  if (bytesPerToken < 8) return '4-8';
  if (bytesPerToken < 32) return '8-32';
  return 'gte32';
}

/**
 * 校准写入密度观测（C7b 删除的替代感知面——纯遥测非门禁）：
 * 坏中转（恒报低值）在写入侧表现为 bytesPerToken 超大（前缀 2MB 只报 1k
 * token → 2000 B/tok）。每渠道每桶只记一次（进程级 Set 去重），日志面
 * 供聚合管道消费；lt1 桶额外 warn——它对诚实内容不可达（B2 钳制保证
 * inputTokens ≤ 字节界 ⇒ 密度 ≥ 1），出现即收据异常。
 */
function observeDensity(
  seen: { channelId: number; inputTokens: number; prefixBytes: number },
  warned: Set<string>,
  log: { warn: (obj: Record<string, unknown>, msg: string) => void },
): void {
  if (seen.prefixBytes <= 0) return;
  const bpt = seen.prefixBytes / seen.inputTokens;
  const bucket = densityBucket(bpt);
  const key = `${seen.channelId}:${bucket}`;
  if (warned.has(key)) return;
  warned.add(key);
  if (bucket === 'lt1') {
    log.warn(
      { channelId: seen.channelId, bucket, bytesPerToken: bpt },
      'calibration density anomaly',
    );
  }
}

/** 校准写入（结算事务提交后独立执行——P10 毒化隔离；失败丢弃可重建） */
const densityObserved = new Set<string>();
const densityLog = {
  warn(obj: Record<string, unknown>, msg: string) {
    console.warn(JSON.stringify({ level: 'warn', msg, ...obj }));
  },
};

export async function writeCalibrationRecord(
  env: SettleEnv,
  input: Parameters<CalibrationStore['upsert']>[1],
): Promise<void> {
  if (env.calibrations == null) return;
  observeDensity(
    {
      channelId: input.channelId,
      inputTokens: input.inputTokens,
      prefixBytes: input.prefixBytes,
    },
    densityObserved,
    densityLog,
  );
  try {
    await env.calibrations.upsert(undefined as never, input);
  } catch {
    // 派生事实：丢弃（下一笔回落保守，非资损）
  }
}
