/**
 * 收据校准运营参数（system_configs KV 'billing_calibration'——docs §3.3）：
 * 校准**恒开**（用户裁决 2026-10-12：删除 enabled/user_side 开关，直接生效）；
 * KV 只承载两个调参：window_ms（前缀匹配窗，对齐上游缓存 TTL）与
 * cache_ratio（缓存段安全系数）。键与值域解析的单一真相在本文件。
 *
 * 值域纪律：cache_ratio ∈ (0,1]；window_ms 正整数上限 1h。
 * 形状/值域异常返回 null——消费方按未配置语义回落缺省（300s / 0.9）。
 */
export const BILLING_CALIBRATION_KEY = 'billing_calibration';

/** 读侧 top-N 与写侧保留条数（docs §3.1 缺省 8——单一真相，两侧共用） */
export const CALIBRATION_RECORD_KEEP = 8;

/** KV 缺省（300s 窗 / 0.9 系数——观察期可经 KV 调整，无需发版） */
export const DEFAULT_CALIBRATION_CONFIG: CalibrationConfig = {
  windowMs: 300_000,
  cacheRatio: 0.9,
};

export interface CalibrationConfig {
  windowMs: number;
  cacheRatio: number;
}

/** KV 值形状（jsonb，留扩展位） */
interface CalibrationValue {
  window_ms?: unknown;
  cache_ratio?: unknown;
}

const WINDOW_MS_MAX = 3_600_000;
const WINDOW_MS_MIN = 1_000;

/**
 * 值域解析：形状/值域校验；任一异常整体 null（不部分采用——半个配置比
 * 没配置更危险）。
 */
export function parseCalibrationSetting(raw: unknown): CalibrationConfig | null {
  if (raw == null || typeof raw !== 'object') return null;
  const { window_ms, cache_ratio } = raw as CalibrationValue;
  if (typeof window_ms !== 'number' || !Number.isInteger(window_ms)) return null;
  if (window_ms < WINDOW_MS_MIN || window_ms > WINDOW_MS_MAX) return null;
  if (typeof cache_ratio !== 'number' || !Number.isFinite(cache_ratio)) return null;
  if (cache_ratio <= 0 || cache_ratio > 1) return null;
  return { windowMs: window_ms, cacheRatio: cache_ratio };
}
