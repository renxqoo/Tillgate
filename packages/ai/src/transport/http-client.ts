import { lookup } from 'node:dns/promises';
import { classifyTransportError } from '../errors/classify.js';

/**
 * fetch 封装（ai-package.md §7.4 传输层）：
 *   - assertSafeUrl：SSRF 防护（https-only + 禁内网/回环，含 DNS 解析后逐地址判定，防 rebinding）
 *   - connectMs：首字节前超时（connect + TTFB），超时抛 timeout 错误（retryable + circuitTrip）
 *   - 外部 AbortSignal：原样透传（withRetry 的 deadline / 客户端断），抛原生 AbortError 交给上层识别
 *   - 网络错误（fetch failed / ECONNREFUSED）→ network 错误（retryable + circuitTrip）
 * 状态码不在此层分类（429/401 等由 adapter.mapError 处理，见阶段 C）
 */

/** IPv4 内网/保留段判定（SSRF 防护） */
export function isUnsafeIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  if (a === 0) return true; // 0.0.0.0/8（本网络）
  if (a === 10) return true; // 10/8 私网
  if (a === 127) return true; // 127/8 回环
  if (a === 169 && b === 254) return true; // 链路本地（含云 metadata 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 私网
  if (a === 192 && b === 168) return true; // 192.168/16 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // 组播/保留
  return false;
}

/** IPv6 内网/保留段判定（SSRF 防护） */
export function isUnsafeIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower.includes('%')) return true; // 链路本地 zone index
  if (lower === '::' || lower === '::1') return true; // 未指定/回环
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  if (
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  ) {
    return true; // 链路本地 fe80::/10
  }
  if (lower.startsWith('ff')) return true; // 组播
  // IPv4-mapped IPv6 (::ffff:a.b.c.d)：提取 IPv4 部分用 isUnsafeIpv4 判定（防绕过）
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped?.[1]) return isUnsafeIpv4(mapped[1]);
  return false;
}

export interface SafeUrlOptions {
  /** 允许 http:// 与内网地址（仅测试/本地调试；生产必须 false） */
  allowLocal?: boolean;
  /** hostname 白名单（跳过 DNS 内网判定，如内网自建渠道的显式配置） */
  allowedHosts?: string[];
}

const PRIVATE_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

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
  if (opts.allowLocal || opts.allowedHosts?.includes(u.hostname)) return u;
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

/**
 * 解析 URL 的 DNS 并校验所有地址安全，返回校验后的首个 IP（防 DNS rebinding TOCTOU）。
 *
 * fetchUpstream 用返回的 IP 直连（固定本次连接的目标地址），而非让 fetch 再次走系统 DNS 解析——
 * 否则 assertSafeUrl 校验与 fetch 实际连接之间，攻击者可换 DNS 答案（rebinding → 169.254.169.254）。
 *
 * 域名解析失败时返回 ip=null（降级：fetchUpstream 用原始 URL，fetch 自然报 network 错误，安全）。
 * allowLocal 时跳过校验返回 null（测试/本地调试）。
 */
export interface ResolvedTarget {
  /** 校验后的安全 IP（null = 降级用原始 hostname） */
  ip: string | null;
  /** 原始 hostname（用于 Host 头 + TLS SNI） */
  hostname: string;
  /** 端口 */
  port: number;
}

export async function resolveAndPin(url: string, opts: SafeUrlOptions = {}): Promise<ResolvedTarget> {
  const u = assertSafeUrlSync(url, opts);
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (opts.allowLocal || opts.allowedHosts?.includes(hostname)) {
    return { ip: null, hostname, port };
  }
  let addresses: string[];
  try {
    addresses = (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    return { ip: null, hostname, port };
  }
  for (const addr of addresses) {
    const unsafe = addr.includes(':') ? isUnsafeIpv6(addr) : isUnsafeIpv4(addr);
    if (unsafe) throw new Error(`blocked address: ${hostname} resolves to ${addr}`);
  }
  return { ip: addresses[0] ?? null, hostname, port };
}

export interface FetchUpstreamOptions {
  /** 首字节前超时（connect + TTFB），默认见 aiConfig.timeout.connectMs */
  connectMs: number;
  /** 外部取消信号（withRetry deadline / 调用方中止） */
  signal?: AbortSignal;
  allowLocal?: boolean;
  allowedHosts?: string[];
}

/**
 * fetch 封装：DNS 解析固定 IP（防 rebinding TOCTOU）→ connectMs 超时 → 外部信号传播 → 错误分类。
 * 返回原始 Response（含非 2xx，状态码分类由 adapter.mapError 负责）；body 由调用方接管。
 *
 * SSRF 防护（防 DNS rebinding）：
 *   - resolveAndPin 先解析 DNS 并校验所有地址公网安全
 *   - 用校验后的 IP 直连（undici dispatcher 固定连接目标），不再让 fetch 二次走系统 DNS
 *   - TLS SNI / Host 头仍用原始 hostname（证书校验正常）
 */
export async function fetchUpstream(
  url: string,
  init: RequestInit,
  opts: FetchUpstreamOptions,
): Promise<Response> {
  const target = await resolveAndPin(url, opts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('connect timeout')), opts.connectMs);
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
  try {
    // 用校验后的 IP 直连（防 rebinding TOCTOU）：自定义 DNS lookup 固定到已校验的 IP。
    // 保留原始 URL（hostname 不变 → TLS 证书校验 + Host 头正确），
    // 仅覆盖连接层的目标地址（undici connect.lookup 返回校验后的 IP）。
    if (target.ip) {
      const family = target.ip.includes(':') ? 6 : 4;
      const undici = await import('undici');
      const dispatcher = new undici.Agent({
        connect: {
          // 自定义 lookup：忽略系统 DNS，返回已校验的安全 IP（防 rebinding）
          // undici net.connect lookup 签名：(hostname, optionsOrCallback, callback?)
          lookup: (hostname: string, lookupOpts: unknown, callback?: unknown) => {
            const cb = (typeof lookupOpts === 'function' ? lookupOpts : callback) as (
              err: NodeJS.ErrnoException | null,
              addresses: Array<{ address: string; family: number }>,
            ) => void;
            cb(null, [{ address: target.ip!, family }]);
          },
        },
      });
      // 用 undici.fetch（而非 undici.request）：
      //   undici.request 等完整响应体才 resolve → 流式被缓冲（非真流式）
      //   undici.fetch 支持 dispatcher + res.body 是真 ReadableStream（逐块推送）
      const res = await undici.fetch(url, {
        method: (init.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH') ?? 'GET',
        headers: init.headers as Record<string, string>,
        body: (init.body as string | undefined) ?? undefined,
        signal: controller.signal,
        dispatcher,
      });
      return res;
    }
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (opts.signal?.aborted) {
      throw new Error('aborted', { cause: err });
    }
    if (controller.signal.aborted) {
      throw classifyTransportError('timeout');
    }
    throw classifyTransportError('network');
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
 * opts.signal 联动：abort 时 reader.cancel()，读循环以 done 退出（不抛 AbortError，
 * 调用方拿到截断的 body——调用方应在 signal.aborted 后丢弃结果并按 aborted 分类）。
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
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
