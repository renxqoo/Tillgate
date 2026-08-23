/**
 * 错误出站脱敏（§3.6 透传例外 3 内容层）：
 * 上游错误原文进 C 端信封前做且仅做三类处理——
 *   1. 内部名替换（redactions：真实部署模型名等 → 对外目录名）；
 *   2. 剥内部寻址（URL / 主机:端口 / IP → '[redacted]'——内部端点不暴露给 C 端）；
 *   3. 长度截断（maxLen，默认 512——超长错误体不放大响应）。
 * 不编造友好消息（保真原则）；原始全文保留在 UpstreamError.rawBody 与日志路径（细节层）。
 */

/** 出站脱敏统一占位符（内部寻址不可推断对外名，直接遮蔽） */
export const REDACTED = '[redacted]';

/** 单行 message 的出站截断默认值（可配置） */
export const DEFAULT_SANITIZE_MAX_LEN = 512;

export interface SanitizeDetailOptions {
  /** 截断上限（字符数），默认 512 */
  maxLen?: number;
  /** 需替换为对外名的内部字符串（split/join 字面替换，不做正则转义） */
  redactions?: string[];
  /** redactions 命中的替换目标（对外目录模型名）；缺省 '[redacted]' */
  replacement?: string;
}

// 内部寻址模式（顺序：URL → IPv4[:port] → host:port → IPv6——先长后短防部分遮蔽）
const URL_RE = /https?:\/\/[^\s"'`<>()]+/gi;
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d{1,5})?\b/g;
const HOST_PORT_RE = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(?::\d{1,5})\b/g;
const IPV6_RE =
  /(?<![0-9a-fA-F:])(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}(?![0-9a-fA-F:])|(?<![0-9a-fA-F:])::1(?![0-9a-fA-F:])/g;

/** 上游错误 message 的出站脱敏（三类处理；空串原样返回） */
export function sanitizeUpstreamDetail(detail: string, opts: SanitizeDetailOptions = {}): string {
  if (detail === '') return detail;
  let out = detail;
  // 1. 内部名 → 对外名（先于寻址剥除：对外名自身可能含点号，避免被 host 模式误吃）
  const to = opts.replacement ?? REDACTED;
  for (const needle of opts.redactions ?? []) {
    if (needle === '') continue;
    out = out.split(needle).join(to);
  }
  // 2. 剥内部寻址
  out = out
    .replace(URL_RE, REDACTED)
    .replace(IPV4_RE, REDACTED)
    .replace(HOST_PORT_RE, REDACTED)
    .replace(IPV6_RE, REDACTED);
  // 3. 截断（最后执行——脱敏标记不被截断丢失）
  const maxLen = opts.maxLen ?? DEFAULT_SANITIZE_MAX_LEN;
  if (out.length > maxLen) return out.slice(0, maxLen);
  return out;
}
