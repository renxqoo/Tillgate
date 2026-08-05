import { type Usage, estimateTokens, extractRequestChars } from '@ai-gateway/ai';

/**
 * 流式 usage 缺失时的兜底估算（events.ts 契约 §14 / requirements 5.11）：
 *   success.usage 为空 + bytesRelayed > 0 → gateway 按已透字节估算 tokens
 *
 * 真实驱动场景：MiniMax-M3 流式全程不发 usage（每帧 usage:null），
 * 不兜底则成功响应却从不结算（漏计费 + hold key 残留到 TTL 过期）。
 *
 * 估算口径：
 *   outputTokens = estimateTokens(bytesRelayed / UTF8_AVG_BYTES_PER_CHAR, 3.5)
 *     —— SSE 流是 UTF-8 字节，中文 3 字节/字符、ASCII 1 字节/字符，取 3 作折中（偏保守多计）
 *   inputTokens  = estimateTokens(请求字符数, 3.5)
 *     —— 输入侧已知（请求体在 gateway 手上），用 ai 包 extractRequestChars（含 tools）
 *   cachedInputTokens = 0（估算无法区分缓存命中，全部按未缓存计）
 *   estimated = true（worker 据此标 tokens_estimated，审计可识别估算值）
 */

/** UTF-8 平均字节/字符（中文 3 字节、ASCII 1 字节的折中值，输出 token 估算用） */
const UTF8_AVG_BYTES_PER_CHAR = 3;
/** 字符→token 系数（与 ai 包默认 charPerToken 一致） */
const CHAR_PER_TOKEN = 3.5;

/**
 * @param reqBody 请求体（用于估算输入 tokens：messages.content + tools）
 * @param bytesRelayed 已透传给客户端的字节数（流式 success.bytesRelayed）
 * @returns 估算的 Usage；bytesRelayed ≤ 0 时返回 null（完全无输出，不计费）
 */
export function estimateStreamUsage(
  reqBody: Record<string, unknown>,
  bytesRelayed: number,
): Usage | null {
  if (bytesRelayed <= 0) return null;
  const outputChars = Math.max(1, Math.ceil(bytesRelayed / UTF8_AVG_BYTES_PER_CHAR));
  return {
    inputTokens: estimateTokens(extractRequestChars(reqBody), CHAR_PER_TOKEN),
    cachedInputTokens: 0,
    outputTokens: estimateTokens(outputChars, CHAR_PER_TOKEN),
    estimated: true,
    raw: { bytesRelayed, source: 'gateway_bytes_estimate' },
  };
}

/**
 * 非流式 usage 缺失时的兜底估算（与 estimateStreamUsage 对称，防漏计费）。
 *
 * 触发场景：上游返回 200+JSON 但无 usage 字段，且 ai 包 extractUsage/estimateUsage
 * 也未命中（理论上不会发生，但防御性兜底——与流式分支对称）。
 * 不兜底则 settled=true 但不入队 → hold 残留 10min + 永不计费。
 *
 * @param reqBody 请求体（估算输入 tokens）
 * @param resBody 上游响应 JSON（从 choices[].message.content 估算输出 tokens）
 * @returns 估算的 Usage；resBody 无可提取 content 时返回 null（无输出不计费）
 */
export function estimateNonStreamUsage(
  reqBody: Record<string, unknown>,
  resBody: unknown,
): Usage | null {
  // 从响应体提取所有 content 字符（choices[].message.content）
  let outputChars = 0;
  if (resBody && typeof resBody === 'object') {
    const choices = (resBody as { choices?: unknown }).choices;
    if (Array.isArray(choices)) {
      for (const ch of choices) {
        const msg = (ch as { message?: { content?: unknown } })?.message;
        const content = msg?.content;
        if (typeof content === 'string') outputChars += content.length;
      }
    }
  }
  // 输入始终可计费（请求体在 gateway 手上）；输出可能为 0（embeddings 无文本输出）
  // 即便 outputChars=0 也按输入估算入队（防漏计费 + hold 残留）
  return {
    inputTokens: estimateTokens(extractRequestChars(reqBody), CHAR_PER_TOKEN),
    cachedInputTokens: 0,
    outputTokens: estimateTokens(outputChars, CHAR_PER_TOKEN),
    estimated: true,
    raw: { source: 'gateway_nonstream_estimate' },
  };
}
