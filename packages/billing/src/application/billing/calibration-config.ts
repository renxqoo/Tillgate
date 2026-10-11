/**
 * 收据校准运营配置（system_configs KV 'billing_calibration'——docs §3.3）：
 * enabled/window_ms/cache_ratio/user_side 四参数，admin settings 面写入、
 * 网关热路径 TTL 读。键与值域解析的单一真相在本文件。
 *
 * 值域纪律（v4-P8）：cache_ratio ∈ (0,1]（zod 同款锁）；window_ms 正整数
 * 上限 1h；enabled=false 时 user_side 必须为 false（superRefine 同款语义）。
 * 形状/值域异常返回 null——消费方按未配置语义回落（保守缺省：关闭）。
 */
export const BILLING_CALIBRATION_KEY = 'billing_calibration';

/** 读侧 top-N 与写侧保留条数（docs §3.1 缺省 8——单一真相，两侧共用） */
export const CALIBRATION_RECORD_KEEP = 8;

/** KV 缺省（保守方向：关闭、短窗、高 ratio、用户侧不启用——docs §3.3 表） */
export const DEFAULT_CALIBRATION_CONFIG: CalibrationConfig = {
  enabled: false,
  windowMs: 300_000,
  cacheRatio: 0.9,
  userSide: false,
};

export interface CalibrationConfig {
  enabled: boolean;
  windowMs: number;
  cacheRatio: number;
  userSide: boolean;
}

/** KV 值形状（jsonb，留扩展位） */
interface CalibrationValue {
  enabled?: unknown;
  window_ms?: unknown;
  cache_ratio?: unknown;
  user_side?: unknown;
}

const WINDOW_MS_MAX = 3_600_000;
const WINDOW_MS_MIN = 1_000;

/**
 * 值域解析：四参数形状/值域校验；任一异常整体 null（不部分采用——半个
 * 配置比没配置更危险）。enabled=false 且 user_side=true 属矛盾配置，拒绝。
 */
export function parseCalibrationSetting(raw: unknown): CalibrationConfig | null {
  if (raw == null || typeof raw !== 'object') return null;
  const { enabled, window_ms, cache_ratio, user_side } = raw as CalibrationValue;
  if (typeof enabled !== 'boolean') return null;
  if (typeof user_side !== 'boolean') return null;
  if (!enabled && user_side) return null; // 矛盾：总开关关用户侧开
  if (typeof window_ms !== 'number' || !Number.isInteger(window_ms)) return null;
  if (window_ms < WINDOW_MS_MIN || window_ms > WINDOW_MS_MAX) return null;
  if (typeof cache_ratio !== 'number' || !Number.isFinite(cache_ratio)) return null;
  if (cache_ratio <= 0 || cache_ratio > 1) return null;
  return { enabled, windowMs: window_ms, cacheRatio: cache_ratio, userSide: user_side };
}
