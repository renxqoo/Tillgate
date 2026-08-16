import { USER_SIDE_CANCELS, type UserSideCancel } from '@ai-gateway/ledger';
import { resolveCalibration } from '@ai-gateway/ai';

/**
 * 用户侧取消的 usage 估算器（权威公式单一真相，events.ts 契约的消费端）：
 *
 *   outputTokens = round(bytesRelayed × tokensPerByte)
 *     tokensPerByte 来自固定校准配置（按 provider/model 覆盖）——
 *     SSE 线上字节含协议包装，直觉常数会错一个数量级，必须实测校准，
 *     与文本权重同源（ai/calibration.ts 代码内固定值），不硬编码在调用点。
 *   inputTokens = estimateInputTokens(body)（与预扣同源单一真相，CJK 感知）。
 *   cachedInputTokens = round(inputTokens × ESTIMATED_INPUT_CACHE_SHARE)——
 *     现行常量 = 0（一律全价，new-api 口径防套利）；历史口径与切换方式见常量注释。
 *   硬夹：output ≤ maxOutputTokens（input 已与预扣同源，无需二次上界夹）。
 */

export interface EstimateCancelledUsageInput {
  model: string;
  providerName?: string;
  /** 输入 token 估算（estimateInputTokens(body)，与预扣同源） */
  inputTokens: number;
  /** 中继透传的线上字节数；TTFB 期取消为 0（output 估算为 0） */
  bytesRelayed: number;
  maxOutputTokens: number;
}

export interface EstimatedUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  estimated: true;
  /** 原始 usage 保留位（估算场景无上游原始数据，置空对象） */
  raw: Record<string, never>;
}

/**
 * 估算 input 的缓存折扣份额（政策开关，单一真相）：
 *   0    = 一律全价（现行，2026-08-16 拍板，对齐 One API/New API 口径）。
 *          防「改字破缓存 + 取消」套利：攻击者改一个字让上游按全价结算（缓存失效），
 *          若我们按缓存价估算则单笔产生 ~80% input 差价（170k ctx ≈ 0.29 元/笔）。
 *          若将来要恢复「按实测比率给缓存折扣」（对诚实高缓存 agent 用户更友好），
 *          改成此值即可：cachedInputTokens = round(inputTokens × 本常量)。
 *   1.0  = 全缓存价（v1 旧口径，保守下界）——已被上述套利分析否决，勿回退。
 * ⚠️ 任何 >0 的取值都会重新打开套利面（我们按折扣收、上游按全价收），
 *    修改前先评估：或配合按 key 实测命中率使用（该用户自己的 settled 单证据）。
 */
export const ESTIMATED_INPUT_CACHE_SHARE = 0;

export function estimateCancelledUsage(input: EstimateCancelledUsageInput): EstimatedUsage {
  const { tokensPerByte } = resolveCalibration(input.providerName, input.model);
  const outputTokens = Math.min(
    Math.round(input.bytesRelayed * tokensPerByte),
    input.maxOutputTokens,
  );
  return {
    inputTokens: input.inputTokens,
    cachedInputTokens: Math.round(input.inputTokens * ESTIMATED_INPUT_CACHE_SHARE),
    outputTokens,
    estimated: true,
    raw: {},
  };
}

/** 用户侧取消判定（与 ledger USER_SIDE_CANCELS 同源；流终态原因/aborted 错误码 → 估算归属） */
export function asUserSideCancel(reason: string | undefined): UserSideCancel | undefined {
  return USER_SIDE_CANCELS.find((entry) => entry === reason);
}

export { USER_SIDE_CANCELS };
