import { lookup } from 'node:dns/promises';
import { UpstreamError } from '../errors/kinds';
import type { UrlGuard } from '../types';

/**
 * fetch 封装（ai-package.md §7.4 传输层）：
 *   - assertSafeUrl：SSRF 防护（https-only + 禁内网/回环，含 DNS 解析后逐地址判定，防 rebinding）
 *   - connectMs：首字节前超时（connect + TTFB），超时抛 timeout 错误（retryable + circuitTrip）
 *   - 外部 AbortSignal：原样透传（withRetry 的 deadline / 客户端断），抛原生 AbortError 交给上层识别
 *   - 网络错误（fetch failed / ECONNREFUSED）→ network 错误（retryable + circuitTrip）
 * 状态码不在此层分类（429/401 等由 adapter.mapError 处理，见阶段 C）
 */

/** 按首字节的 IPv4 保留段判定表（入参为次字节 b）；未列出的首字节 → 公网 */
const IPV4_RESERVED_BY_FIRST_OCTET: ReadonlyMap<number, (b: number) => boolean> = new Map<
  number,
  (b: number) => boolean
>([
  [0, () => true], // 0.0.0.0/8（本网络）
  [10, () => true], // 10/8 私网
  [100, (b) => b >= 64 && b <= 127], // 100.64/10 CGNAT
  [127, () => true], // 127/8 回环
  [169, (b) => b === 254], // 链路本地（含云 metadata 169.254.169.254）
  [172, (b) => b >= 16 && b <= 31], // 172.16/12 私网
  [192, (b) => b === 168], // 192.168/16 私网
]);

/** IPv4 内网/保留段判定（SSRF 防护）——保留段表见 IPV4_RESERVED_BY_FIRST_OCTET */
export function isUnsafeIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a = -1, b = -1] = parts;
  if (a >= 224) return true; // 组播/保留
  return IPV4_RESERVED_BY_FIRST_OCTET.get(a)?.(b) === true;
}

/**
 * IPv6 文本 → 8 组 hextet（尾段 dotted IPv4 折算为两组；非法形态返回 null）。
 * 覆盖两类入参形态：WHATWG URL 规范化压缩形（hex）与 getaddrinfo 结果的 dotted 尾段形。
 */
function parseIpv6Side(side: string): number[] | null {
  if (side === '') return [];
  const groups = side.split(':');
  const dotted = groups.at(-1)?.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  const tail = dotted?.slice(1).map(Number);
  if (tail) {
    if (tail.some((o) => (o ?? 0) > 255)) return null;
    groups.pop();
  }
  const hextets = groups.map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN,
  );
  if (hextets.some(Number.isNaN)) return null;
  if (!tail) return hextets;
  return [
    ...hextets,
    ((tail.at(0) ?? 0) << 8) | (tail.at(1) ?? 0),
    ((tail.at(2) ?? 0) << 8) | (tail.at(3) ?? 0),
  ];
}

function parseIpv6Hextets(ip: string): number[] | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const left = parseIpv6Side(halves.at(0) ?? '');
  const right = halves.length === 2 ? parseIpv6Side(halves.at(1) ?? '') : [];
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const zeros = 8 - left.length - right.length;
  return zeros >= 0 ? [...left, ...Array.from({ length: zeros }, () => 0), ...right] : null;
}

/** 两组 hextet → dotted IPv4（供内嵌段判定复用） */
function ipv4Of(hi: number | undefined, lo: number | undefined): string {
  return `${(hi ?? 0) >> 8}.${(hi ?? 0) & 0xff}.${(lo ?? 0) >> 8}.${(lo ?? 0) & 0xff}`;
}

const isZeroHextet = (h: number): boolean => h === 0;

/** 尾 32 位内嵌 IPv4 的前缀族：::/96（compatible）/ ::ffff:0:0/96（mapped）/ 64:ff9b::/96（NAT64） */
function hasTailEmbeddedIpv4(h: number[]): boolean {
  return (
    h.slice(0, 6).every(isZeroHextet) ||
    (h.slice(0, 5).every(isZeroHextet) && h.at(5) === 0xffff) ||
    (h.at(0) === 0x64 && h.at(1) === 0xff9b && h.slice(2, 6).every(isZeroHextet))
  );
}

/**
 * IPv6 内网/保留段判定（SSRF 防护）。内嵌 IPv4 语义全量解包（2026-08-25 审计复核 #3）：
 *   - 尾 32 位族（hasTailEmbeddedIpv4）：`::/96`（IPv4-compatible：`::127.0.0.1`
 *     与 URL 规范化形 `::7f00:1`）、`::ffff:0:0/96`（mapped，dotted 与压缩 hex 形
 *     均覆盖）、`64:ff9b::/96`（NAT64 well-known 前缀）；
 *   - `2002::/16`（6to4）：第 2/3 组为内嵌 IPv4（经 6to4 网关可达私网段）。
 * 内嵌 IPv4 命中保留段 → 整地址拒绝；非法形态按不安全处理（防御对称）。
 * `2001:db8::/32` 文档段维持放行（不可路由，仅信息面）。
 */
export function isUnsafeIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower.includes('%')) return true; // 链路本地 zone index
  if (lower === '::' || lower === '::1') return true; // 未指定/回环
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  // 链路本地 fe80::/10（fe8/fe9/fea/feb 四个前缀）
  if (['fe8', 'fe9', 'fea', 'feb'].some((p) => lower.startsWith(p))) return true;
  if (lower.startsWith('ff')) return true; // 组播
  const hextets = parseIpv6Hextets(lower);
  if (!hextets) return true;
  if (hasTailEmbeddedIpv4(hextets) && isUnsafeIpv4(ipv4Of(hextets.at(6), hextets.at(7)))) {
    return true;
  }
  if (hextets.at(0) === 0x2002 && isUnsafeIpv4(ipv4Of(hextets.at(1), hextets.at(2)))) return true;
  return false;
}

/** 全放行守卫（测试/本地调试显式注入——声明「本进程不做 SSRF 门控」的策略语义） */
export const allowAllUrls: UrlGuard = async () => {};

export interface SafeUrlOptions {
  /** 允许 http:// 与内网地址（仅测试/本地调试；生产必须 false） */
  allowLocal?: boolean;
  /** 生产可调用的受信 hostname 白名单；命中后仍执行 DNS 私网地址校验。 */
  allowedHosts?: string[];
}

const PRIVATE_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

function isIpLiteral(host: string): boolean {
  return host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** 同步快速校验：协议 + hostname 形态 + 字面量 IP 段判定（域名解析校验走异步版本） */
export function assertSafeUrlSync(url: string, opts: SafeUrlOptions = {}): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new TypeError(`invalid upstream url: ${url}`);
  }
  if (u.protocol !== 'https:' && !(opts.allowLocal && u.protocol === 'http:')) {
    throw new Error(`unsupported protocol: ${u.protocol}`);
  }
  if (!u.hostname) throw new Error(`empty hostname: ${url}`);
  if (opts.allowLocal) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOSTS.has(host.toLowerCase())) {
    throw new Error(`blocked host: ${host}`);
  }
  if (isIpLiteral(host)) {
    const unsafe = host.includes(':') ? isUnsafeIpv6(host) : isUnsafeIpv4(host);
    if (unsafe) throw new Error(`blocked address: ${host}`);
  }
  return u;
}

/**
 * 完整校验：同步快速失败 + DNS 解析后逐地址判定（防 DNS rebinding）。
 * 域名解析失败时放行（交给 fetch 自然报 network 错误，未解析=无法发起连接，安全）。
 */
export async function assertSafeUrl(url: string, opts: SafeUrlOptions = {}): Promise<URL> {
  const u = assertSafeUrlSync(url, opts);
  if (opts.allowLocal) return u;
  const hostname = u.hostname.toLowerCase();
  if (opts.allowedHosts?.length && !opts.allowedHosts.includes(hostname)) {
    throw new Error(`upstream host is not allowlisted: ${hostname}`);
  }
  let addresses: string[];
  try {
    addresses = (await lookup(u.hostname, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    return u;
  }
  for (const addr of addresses) {
    const unsafe = addr.includes(':') ? isUnsafeIpv6(addr) : isUnsafeIpv4(addr);
    if (unsafe) throw new Error(`blocked address: ${u.hostname} resolves to ${addr}`);
  }
  return u;
}

export interface FetchUpstreamOptions {
  /** 首字节前超时（connect + TTFB），默认见 aiConfig.timeout.connectMs */
  connectMs: number;
  /** 外部取消信号（withRetry deadline / 调用方中止） */
  signal?: AbortSignal;
  /** SSRF 策略注入点：注入则整体替换内置守卫；缺省执行机械基线 */
  guard?: UrlGuard;
}

/**
 * fetch 封装：受信 host + DNS 私网校验 → connectMs 超时 → 外部信号传播 → 错误分类。
 * 返回原始 Response（含非 2xx，状态码分类由 adapter.mapError 负责）；body 由调用方接管。
 *
 * SSRF 防护：生产必须配置受信 provider hostname 白名单，同时逐个拒绝 DNS 私网地址。
 * 白名单从根上禁止用户/数据库注入任意攻击者域名；TLS 仍校验原 hostname。
 */
export async function fetchUpstream(
  url: string,
  init: RequestInit,
  opts: FetchUpstreamOptions,
): Promise<Response> {
  // 已中止的信号不会再发 abort 事件（addEventListener 不回放）——派发前取消不得发出请求
  if (opts.signal?.aborted) throw new Error('aborted before dispatch');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('connect timeout')), opts.connectMs);
  // abort 事件不回放：监听必须在任何 await 之前挂，否则中止发生在 DNS 解析期间会丢失
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
  try {
    // SSRF/协议校验错误原样上抛（具体错误信息是测试与排障契约，不吞成 network）
    if (opts.guard) await opts.guard(url);
    else await assertSafeUrl(url);
  } catch (error) {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
    throw error;
  }
  try {
    // 原生 fetch 保持响应体逐块流式传输；生产安全边界是不可由请求方控制的
    // provider host allowlist（装配注入 allowedHosts），加上 DNS 私网地址检查
    // 和 HTTPS 证书校验。
    // redirect:'manual'：守卫只校验初始 URL，自动跟随 3x 等于让未过审目标
    // （含 http 内网/metadata 降级跳转）绕过守卫——3x 按 非 2xx 交 mapError 分类。
    return await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
  } catch (error) {
    if (opts.signal?.aborted) {
      throw new Error('aborted', { cause: error });
    }
    if (controller.signal.aborted) {
      throw new UpstreamError({ kind: 'timeout', message: 'connect timeout / transport timeout' });
    }
    throw new UpstreamError({ kind: 'network', message: 'upstream network error' });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 响应体超限错误（readBody 抛出；上层按 code/instanceof 判定，不靠字符串匹配）。
 * 语义 retryable=false：上游就是返回了超大 body，重试也是一样。
 */
export class BodyTooLargeError extends Error {
  readonly code = 'body_too_large' as const;
  constructor(maxBytes: number) {
    super(`response body exceeds ${maxBytes} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * 读完整响应体（限长，防超大响应拖垮内存）；超限抛 BodyTooLargeError 并取消读取。
 * opts.signal 联动：abort 时 reader.cancel()，读循环以 done 退出后**抛 `'aborted'`**
 * （2026-08-25 收口：旧契约「返回截断体 + 调用方自查」已被调用方违约——取消中的
 * 响应曾被误分类 invalid_response 而非 canceled。中止即错，上层按 canceled 归类）。
 */
export async function readBody(
  res: Response,
  opts: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  if (!res.body) return '';
  const reader = res.body.getReader();
  // signal 接入：abort → cancel reader，让正在 pending 的 read() 以 done 退出（不再 hang）
  const onAbort = (): void => {
    void reader.cancel().catch(() => {});
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
    if (opts.signal?.aborted) throw new Error('aborted');
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** 读完整响应体（二进制，限长同 readBody；abort 抛 `'aborted'`）——audio_speech 等二进制端点用 */
export async function readRawBody(
  res: Response,
  opts: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => {});
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BodyTooLargeError(maxBytes);
      }
      // done-break 后 value 已由 ReadableStreamReadResult 判别联合收窄
      chunks.push(value);
    }
    if (opts.signal?.aborted) throw new Error('aborted');
    return Buffer.concat(chunks);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
