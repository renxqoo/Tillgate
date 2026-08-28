/**
 * 错误出站脱敏：
 * 上游错误原文进 C 端信封前做且仅做三类处理——
 *   1. 内部名替换（redactions：真实部署模型名等 → 对外目录名）；
 *   2. 剥内部寻址（URL / 主机:端口 / IP → '[redacted]'——内部端点不暴露给 C 端）；
 *   3. 长度截断（maxLen，默认 512——超长错误体不放大响应）。
 * 不编造友好消息（保真原则）；原始全文保留在 UpstreamError.rawBody 与日志路径。
 */

/** 出站脱敏统一占位符（内部寻址不可推断对外名，直接遮蔽） */
export const REDACTED = '[redacted]';

/** 单行 message 的出站截断默认值（可配置） */
export const DEFAULT_SANITIZE_MAX_LEN = 512;

/** 逐项配对替换（realModel 各自映射到自己的对外目录名——候选链多维替换） */
export interface SanitizeRedactionPair {
  needle: string;
  replacement: string;
}

export interface SanitizeDetailOptions {
  /** 截断上限（字符数），默认 512 */
  maxLen?: number;
  /** 需替换的内部字符串（split/join 字面替换，不做正则转义）：字符串项替换为
   *  replacement（缺省 '[redacted]'），配对项各自指定对外名。 */
  redactions?: Array<string | SanitizeRedactionPair>;
  /** 字符串形态 redactions 的替换目标；缺省 '[redacted]' */
  replacement?: string;
}

// 内部寻址模式（顺序：URL → IPv4[:port] → host:port → IPv6——先长后短防部分遮蔽）
const URL_RE = /https?:\/\/[^\s"'`<>()]+/gi;
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d{1,5})?\b/g;
const HOST_PORT_RE = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(?::\d{1,5})\b/g;
const IPV6_RE =
  /(?<![0-9a-fA-F:])(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}(?![0-9a-fA-F:])|(?<![0-9a-fA-F:])::1(?![0-9a-fA-F:])/g;

/** 上游错误 message 的出站脱敏（三类处理；空串原样返回） */
/**
 * 内部名替换（单趟最长优先）：所有 needle 拼成交替正则一次替换——顺序 split/join
 * 在 needle 互为子串（gpt-4 / gpt-4o）或 replacement 含其它 needle 时会产生
 * 杂交名或链式二次替换；单趟按最长优先匹配天然免疫两类形态。
 */
function applyRedactions(detail: string, opts: SanitizeDetailOptions): string {
  const entries = (opts.redactions ?? [])
    .map((entry) =>
      typeof entry === 'string'
        ? { needle: entry, replacement: opts.replacement ?? REDACTED }
        : entry,
    )
    .filter((entry) => entry.needle !== '');
  if (entries.length === 0) return detail;
  const byNeedle = new Map(entries.map((entry) => [entry.needle, entry.replacement]));
  const needles = [...byNeedle.keys()].toSorted((a, b) => b.length - a.length);
  const pattern = new RegExp(needles.map(escapeRegExp).join('|'), 'g');
  return detail.replace(pattern, (matched) => byNeedle.get(matched) ?? matched);
}

/** 正则字面转义（needle 是模型名字面，不是模式） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeUpstreamDetail(detail: string, opts: SanitizeDetailOptions = {}): string {
  if (detail === '') return detail;
  // 1. 内部名 → 对外名（先于寻址剥除：对外名自身可能含点号，避免被 host 模式误吃）
  let out = applyRedactions(detail, opts);
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
