/**
 * 可信代理感知的客户端 IP 提取——XFF 信任模型的单一实现。
 *
 * 语义：TRUSTED_PROXY_HOPS = 部署在前面的反向代理层数。
 *   - hops=0（默认，安全兜底）：完全不信任 X-Forwarded-For / X-Real-IP——
 *     直连部署下这些头可由客户端任意伪造；只用不可伪造的 socket 地址。
 *   - hops=N>0：XFF 从右往左数第 N 跳是「我们信任的第一层代理看到的客户端 IP」。
 *     例：hops=1（单层 nginx）。客户端伪造 `X-Forwarded-For: fake` 时，nginx 追加真实
 *     IP 得 `fake, real`，取右数第 1 跳 = real——伪造头被结构性丢弃。
 *   - 部署责任：hops 必须等于真实代理层数；配错（代理后配 0 = 全员共享代理 IP，
 *     直连配 >0 = 恢复可伪造）属于部署错误，docs/configuration.md 的
 *     TRUSTED_PROXY_HOPS 条目有明确说明。
 */
import { isIP } from 'node:net';
import type { Context } from 'hono';

/** Bun.serve 注入 env.server 的最小结构面（requestIP 取不可伪造的 socket 对端） */
interface ServeEnv {
  server?: { requestIP(request: Request): { address: string } | null };
}

export interface TrustedClientIpInput {
  headers: Headers;
  /** 可信代理跳数（0=不信任代理头） */
  trustedProxyHops: number;
  /** socket 对端地址（不可伪造；服务端注入） */
  socketAddress?: string | null;
}

let processFallbackIp: string | null = null;

/** 无 XFF 可信且无 socket（测试/极端环境）→ 进程级唯一值，避免跨 worker 共享 unknown 互相污染 */
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
      // 选中跳必须是合法 IP 才可用：该值会进邮件模板/限流维度/爆破计数——
      // 任意串（恶意 XFF 注入）不可外传，回退不可伪造的 socket 对端
      if (candidate != null && isIP(candidate) !== 0) return candidate;
    }
  }
  const socket = input.socketAddress?.trim();
  if (socket) return socket;
  return uniqueFallback();
}

/** 从请求上下文取不可伪造的 socket 对端地址；无连接信息（app.request 测试等）→ null */
export function socketAddressFromContext(c: Context): string | null {
  try {
    const server = (c.env as ServeEnv | undefined)?.server;
    return server?.requestIP(c.req.raw)?.address ?? null;
  } catch {
    return null;
  }
}

/**
 * 从 Hono 上下文提取客户端 IP（Bun.serve 部署形态——serveApp 注入 env.server）。
 * config 只需含 trustedProxyHops。
 */
export function clientIpFromContext(c: Context, config: { trustedProxyHops: number }): string {
  return trustedClientIp({
    headers: c.req.raw.headers,
    trustedProxyHops: config.trustedProxyHops,
    socketAddress: socketAddressFromContext(c),
  });
}
