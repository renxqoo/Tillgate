import type { TerminationReason } from '@tillgate/ai';

/**
 * 估算归属词表与流式归属判定。
 *
 * 计费政策：**部分交付即计费**——上游已处理即扣 input、
 * 已交付输出按特征估算加扣（含上游故障截断的流：渠道成本已发生，网关不吸收损失）；
 * 零交付（first_chunk 前失败）不扣，走换渠/释放。
 * 估算实扣口径向精确收敛；JSON 字节保守上界只作预扣敞口，不作实扣。
 */

/**
 * 用户侧取消原因（收据归属与验收共用子集）。词表源 = @tillgate/ai 的
 * TerminationReason 封闭词表（satisfies 编译期对齐，禁止再收录词表外值）：
 * 终止词表中仅 client_disconnect / request_cancelled 两态属用户侧取消。
 */
export const USER_SIDE_CANCELS = [
  'client_disconnect',
  'request_cancelled',
] as const satisfies readonly TerminationReason[];
export type UserSideCancel = (typeof USER_SIDE_CANCELS)[number];

/**
 * 允许估算结算的全部归属：用户取消三态归一 + 缺 usage / 部分交付细分。
 * usage.estimated=true 时必填且必须属于本词表（billing 验收结构性把关）。
 */
export const ESTIMATE_ATTRIBUTIONS = [
  ...USER_SIDE_CANCELS,
  'usage_missing_completed',
  'usage_missing_nonstream',
  'upstream_error_partial',
  'inactivity_timeout',
  'server_draining',
] as const;
export type EstimateAttribution = (typeof ESTIMATE_ATTRIBUTIONS)[number];

/**
 * 流式 terminated → 估算归属的单一真相（收据装配与验收共用）。
 * 防御性兜底：任何非用户侧终止值都不是「完成」，未知值归 upstream_error_partial
 * ——绝不回落 usage_missing_completed（否则细分口径被未来新增的终止原因稀释）。
 */
export function streamEstimateAttribution(terminated?: string): EstimateAttribution {
  if (terminated === undefined) return 'usage_missing_completed';
  if ((USER_SIDE_CANCELS as readonly string[]).includes(terminated)) return 'client_disconnect';
  if (terminated === 'server_draining') return 'server_draining';
  if (terminated === 'inactivity') return 'inactivity_timeout';
  return 'upstream_error_partial';
}

/** 估算归属判定（billing 验收共用单一真相）：白名单外的估算收据一律拒绝 */
export function isAttributedEstimate(receipt: {
  usage: { estimated: boolean };
  estimatedFor?: string;
}): boolean {
  return (
    receipt.usage.estimated &&
    receipt.estimatedFor !== undefined &&
    (ESTIMATE_ATTRIBUTIONS as readonly string[]).includes(receipt.estimatedFor)
  );
}
