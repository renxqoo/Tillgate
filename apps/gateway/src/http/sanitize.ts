/**
 * 上游错误细节脱敏（错误出站三层之「内容层」）：
 * 剥内部寻址、真实模型名替换为对外名、长度截断——原文保留不编造友好消息。
 */

export interface SanitizeContext {
  /** 对外模型名（替换目标——上游报错含真实部署名时对外统一为目录名） */
  externalModel?: string;
  /** 真实模型名全集（含 fallback 命中链） */
  realModels?: readonly string[];
  maxLength?: number;
}

const URL_RE = /https?:\/\/[^\s"'<>]+/g;
const HOST_RE = /\b[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:\d+)?\b/gi;

export function sanitizeUpstreamDetail(
  raw: string | null | undefined,
  ctx: SanitizeContext = {},
): string {
  const max = ctx.maxLength ?? 200;
  let text = (raw ?? '').trim();
  if (!text) return 'upstream service error';
  text = text.replace(URL_RE, '[upstream]');
  text = text.replace(HOST_RE, '[upstream]');
  // 真实模型名 → 对外名（先长后短防前缀截断替换）
  if (ctx.externalModel != null && ctx.realModels != null && ctx.realModels.length > 0) {
    for (const real of ctx.realModels.toSorted((a, b) => b.length - a.length)) {
      if (real && real !== ctx.externalModel) text = text.split(real).join(ctx.externalModel);
    }
  }
  if (text.length > max) text = `${text.slice(0, max)}…`;
  return text;
}
