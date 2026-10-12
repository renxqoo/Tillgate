/**
 * 收据校准参数读取 + 记录查询桥（装配面适配器，docs §3.3/§7）：
 *   createBillingCalibrationReader —— system_configs KV `billing_calibration`
 *     的进程内 TTL 缓存读（与 reservation-policy reader 同款单飞行语义）。
 *     校准恒开（用户裁决 2026-10-12）——KV 只承载 window/ratio 调参，
 *     值域异常回落缺省 300s/0.9（调参面保守化，非功能开关）。
 *   createCalibrationLookup —— billing facade findRecent 桥成 inference 的
 *     CalibrationLookup（端口形状对齐，零业务逻辑）。
 */
import { eq } from 'drizzle-orm';
import type { DbLike } from '@tillgate/db';
import { systemConfigs } from '@tillgate/db';
import {
  BILLING_CALIBRATION_KEY,
  CALIBRATION_RECORD_KEEP,
  parseCalibrationSetting,
  DEFAULT_CALIBRATION_CONFIG,
  type CalibrationConfig,
  type CalibrationStore,
} from '@tillgate/billing';
import type { CalibrationLookup, CalibrationLookupConfig } from '@tillgate/inference';

export interface BillingCalibrationReaderEnv {
  db: DbLike;
  /** 缓存 TTL ms（过期后下一请求刷新；admin 改动的拾取延迟上界） */
  ttlMs: number;
}

/** 校准配置读取器（quote 准备每次现读经 TTL 缓存） */
export function createBillingCalibrationReader(
  env: BillingCalibrationReaderEnv,
): () => Promise<CalibrationConfig> {
  // 回落可观测（docs §3.3）：调参是恒开形态下唯一降级手段——写坏（脏 KV）
  // 静默回缺省会掩盖运营意图，回落处 warn（console——gateway 日志面统一由
  // pino 捕获 stdout；不引 logger 依赖避免 adapters 层装配耦合）
  let warnedFallback = false;
  let cached: CalibrationConfig | null = null;
  let cachedAt = 0;
  let inflight: Promise<CalibrationConfig> | null = null;
  return async () => {
    if (cached != null && Date.now() - cachedAt < env.ttlMs) return cached;
    if (inflight == null) {
      inflight = (async () => {
        const row = await env.db.query.systemConfigs.findFirst({
          where: eq(systemConfigs.key, BILLING_CALIBRATION_KEY),
          columns: { value: true },
        });
        // 值域解析复用 billing 单一实现：缺失/垃圾 = 缺省调参（warn 一次/缓存周期）
        const parsedNow = parseCalibrationSetting(row?.value);
        if (parsedNow == null && !warnedFallback) {
          warnedFallback = true;
          console.warn(
            '[calibration] KV 解析失败回落缺省调参 300s/0.9（window_ms/cache_ratio 值域检查失败或行缺失）',
          );
        }
        const config = parsedNow ?? DEFAULT_CALIBRATION_CONFIG;
        cached = config;
        cachedAt = Date.now();
        return config;
      })().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };
}

/** 读句柄（postgres billing store 的 read 面——与 billingFacade 读路径同款） */
export interface CalibrationReadHandle {
  read<T>(fn: (conn: unknown) => Promise<T>): Promise<T>;
}

/** 校准记录查询桥（billing store → inference CalibrationLookup 端口形状） */
export function createCalibrationLookup(
  handle: CalibrationReadHandle,
  store: CalibrationStore,
): CalibrationLookup {
  return {
    async findRecent(input) {
      const rows = await handle.read((conn) => store.findRecent(conn as never, input));
      return rows.map((r) => ({
        prefixHash: r.prefixHash,
        channelId: r.channelId,
        inputTokens: r.inputTokens,
        messagesLen: r.messagesLen,
        settledAt: r.settledAt,
      }));
    },
  };
}

/** quote 准备的校准上下文组装（配置→端口上下文；恒开——无 null 分支） */
export async function resolveCalibrationContext(input: {
  reader: () => Promise<CalibrationConfig>;
  lookup: CalibrationLookup;
}): Promise<{ lookup: CalibrationLookup; config: CalibrationLookupConfig }> {
  // reader 已保证非空（回落在 reader 内完成并 warn）——此处无二次回落
  const parsed = await input.reader();
  return {
    lookup: input.lookup,
    config: {
      windowMs: parsed.windowMs,
      cacheRatio: parsed.cacheRatio,
      recentLimit: CALIBRATION_RECORD_KEEP, // 单一真相（billing 导出）
    },
  };
}
