/**
 * 运营系统设置契约（system_configs KV 面）。当前承载 billing_timezone
 * （全系统统一计费时区——schedule 分时段策略的墙钟口径）。
 */
import { z } from 'zod';

export const settingsContracts = {
  /** IANA 名结构性校验在 control-plane 用例（invalid_billing_timezone）——契约层只拦形状 */
  billingTimezoneUpdate: z.object({ timezone: z.string().min(1).max(64) }),
} as const;
