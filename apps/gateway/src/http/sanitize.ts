/**
 * 上游错误细节脱敏：
 * 502/504 信封携带的上游原文可能暴露真实模型名、内部寻址、堆栈式细节——
 * 网关对外只呈现「对外模型名 + 通用描述」。真实细节进日志（requestId 关联），
 * 不进响应体。
 */

export interface SanitizeContext {
  /** 用户请求的对外模型名（替换锚） */
  externalModel?: string;
  /** 候选链真实模型名（全部替换为对外名） */
  realModels?: readonly string[];
  /** 输出长度上界（默认 200——错误 message 不是调试通道） */
  maxLength?: number;
}

export function sanitizeUpstreamDetail(raw: string | undefined | null, ctx: SanitizeContext = {}): string {
  let out = raw && raw.trim().length > 0 ? raw : 'upstream service error';
  // 内部寻址先剥（URL/host:port 形态——防御纵深，上游 message 可能带内部端点）
  out = out.replace(/https?:\/\/[^\s"'<>]+/g, '[upstream]');
  out = out.replace(/\b(?:[\w-]+\.)+[a-z]{2,}(?::\d{2,5})?\b/gi, (match) => (match.includes('.') ? '[upstream]' : match));
  const external = ctx.externalModel || 'the requested model';
  for (const rm of ctx.realModels ?? []) {
    if (rm && rm.length > 1) out = out.split(rm).join(external);
  }
  const maxLength = ctx.maxLength ?? 200;
  if (out.length > maxLength) out = `${out.slice(0, maxLength)}…`;
  return out;
}
