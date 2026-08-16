/**
 * 上游错误信息出站脱敏（api-contract 白标承诺的响应侧闭环）。
 *
 * 上游报错文案常带真实模型 id（如 `nvidia/nemotron-...:free does not exist`）、
 * 供应商标识、内部 URL——成功帧已有 rewriteSseModel 改写，错误面在这里统一收口：
 *   - 真实模型名 → 对外名；供应商标识 → 「上游服务」
 *   - URL → [已隐藏]
 *   - 长度封顶（上游 5xx 页面/HTML 全文不得倾倒给客户端）
 * 原始文案仅进服务端日志与 request_logs（可审计），不出站。
 */

export interface SanitizeContext {
  /** 候选链全部真实模型名（主 + fallback），任意命中都替换为对外名 */
  realModels?: Array<string | null | undefined>;
  externalModel?: string | null;
  providerNames?: Array<string | null | undefined>;
}

const MAX_LEN = 300;
const URL_RE = /https?:\/\/\S+/gi;

export function sanitizeUpstreamDetail(
  raw: string | undefined | null,
  ctx: SanitizeContext = {},
): string {
  let out = raw && raw.trim().length > 0 ? raw : '上游服务错误';
  const external = ctx.externalModel || '当前模型';
  for (const rm of ctx.realModels ?? []) {
    if (rm && rm.length > 1) out = out.split(rm).join(external);
  }
  for (const pn of ctx.providerNames ?? []) {
    if (pn && pn.length > 1) out = out.split(pn).join('上游服务');
  }
  out = out.replace(URL_RE, '[已隐藏]');
  out = out.replace(/<[^>]{1,80}>/g, ''); // 粗剥 HTML 标签（5xx 页面）
  if (out.length > MAX_LEN) out = `${out.slice(0, MAX_LEN)}…`;
  return out;
}
