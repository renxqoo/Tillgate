/**
 * 运营系统设置契约。当前承载 billing_timezone（IANA 墙钟口径）与第三方集成
 * 动态配置 integrations（docs/integration-settings/DESIGN.md §4.1）。
 * 集成字段级校验（词表/URL/端口/enc: 拒绝）在 control-plane 用例——契约层只拦形状。
 */
import { z } from 'zod';

export const settingsContracts = {
  /** IANA 名结构性校验在 control-plane 用例（invalid_billing_timezone）——契约层只拦形状 */
  billingTimezoneUpdate: z.object({ timezone: z.string().min(1).max(64) }),
  /** 集成更新：config 字段三态（缺席=保持 / null=清除 / 值=设置）；键名与形状校验在用例 */
  integrationsUpdate: z.object({
    enabled: z.boolean().optional(),
    config: z.record(z.string().min(1).max(64), z.string().min(1).max(1024).nullable()).optional(),
  }),
} as const;
