/**
 * 可信代理感知的客户端 IP 提取 + BFF 透传出口头(仅 ./next 子入口导出)。
 *
 * 同语义副本:孪生实现在 @tillgate/http/src/network/trusted-client-ip.ts(发布闭包;
 * 两侧语义必须同步演进,测试向量与 http 包 network.test.ts 锁步一致)。
 *
 * 语义:TRUSTED_PROXY_HOPS = 部署在前面的反向代理层数。
 *   - hops=0(默认,安全兜底):完全不信任 X-Forwarded-For / X-Real-IP——
 *     直连部署下这些头可由客户端任意伪造;只用不可伪造的 socket 地址。
 *   - hops=N>0:XFF 从右往左数第 N 跳是「我们信任的第一层代理看到的客户端 IP」。
 *     例:hops=1(单层 nginx)。客户端伪造 `X-Forwarded-For: fake` 时,nginx 追加真实
 *     IP 得 `fake, real`,取右数第 1 跳 = real——伪造头被结构性丢弃。
 *   - 部署责任:hops 必须等于真实代理层数;配错(代理后配 0 = 全员共享代理 IP,
 *     直连配 >0 = 恢复可伪造)属于部署错误,.env.example 有明确注释。
 */
import { headers } from 'next/headers';

export interface TrustedClientIpInput {
  headers: Headers;
  /** 可信代理跳数(0=不信任代理头) */
  trustedProxyHops: number;
  /** socket 对端地址(不可伪造;服务端注入) */
  socketAddress?: string | null;
}

let processFallbackIp: string | null = null;

/** 无 XFF 可信且无 socket(测试/极端环境)→ 进程级唯一值,避免跨 worker 共享 unknown 互相污染 */
function uniqueFallback(): string {
  processFallbackIp ??= `unknown-${crypto.randomUUID()}`;
  return processFallbackIp;
}

export function trustedClientIp(input: TrustedClientIpInput): string {
  const hops = Math.max(0, Math.floor(input.trustedProxyHops));
  if (hops > 0) {
    const xff = input.headers.get('x-forwarded-for');
    if (xff) {
      const parts = xff
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const candidate = parts[parts.length - hops];
      if (candidate) return candidate;
    }
  }
  const socket = input.socketAddress?.trim();
  if (socket) return socket;
  return uniqueFallback();
}

/**
 * BFF 透传真实用户 IP:client-api / admin-api 不在 nginx 后(Next 服务端直连),
 * 没有 XFF 转发时它们的按 IP 爆破锁会把所有用户记成同一个 Next 容器 IP。
 * 链路:浏览器 → nginx(XFF 追加真实 IP) → Next(本层按 TRUSTED_PROXY_HOPS 解出)
 *      → API(XFF: <用户 IP>,API 侧同样 hops=1 采信右数第 1 跳)。
 * 解不出(dev 直连 hops=0 / 非请求上下文如构建期)→ 不带该头,API 回落 socket。
 * TRUSTED_PROXY_HOPS 逐调用读取(热更新 env 可生效)。
 */
export async function outgoingUserIpHeader(): Promise<Record<string, string>> {
  try {
    const ip = trustedClientIp({
      headers: await headers(),
      trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS ?? 0) || 0,
      socketAddress: null,
    });
    return ip.startsWith('unknown-') ? {} : { 'x-forwarded-for': ip };
  } catch {
    return {}; // 非请求上下文(SSG 构建等):无入站请求头可解
  }
}
