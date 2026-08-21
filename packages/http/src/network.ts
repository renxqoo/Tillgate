/**
 * 可信代理感知的客户端 IP 提取（XFF 信任模型的单一实现）。
 *
 * 语义：TRUSTED_PROXY_HOPS = 部署在前面的反向代理层数。
 *   - hops=0（默认，安全兜底）：完全不信任 X-Forwarded-For / X-Real-IP——
 *     直连部署下这些头可由客户端任意伪造；只用不可伪造的 socket 地址。
 *   - hops=N>0：XFF 从右往左数第 N 跳是「我们信任的第一层代理看到的客户端 IP」。
 *     例：hops=1（单层 nginx）。客户端伪造 `X-Forwarded-For: fake` 时，nginx 追加真实
 *     IP 得 `fake, real`，取右数第 1 跳 = real——伪造头被结构性丢弃。
 *   - 部署责任：hops 必须等于真实代理层数；配错（代理后配 0 = 全员共享代理 IP，
 *     直连配 >0 = 恢复可伪造）属于部署错误，.env.example 有明确注释。
 */
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

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
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      const candidate = parts[parts.length - hops];
      if (candidate) return candidate;
    }
  }
  const socket = input.socketAddress?.trim();
  if (socket) return socket;
  return uniqueFallback();
}

// ─────────────────────────────────────────────────────────────────────────────
// Hono 上下文封装：auth/admin-auth 等路由的「conninfo socket 地址 + 信任代理头」
// 组合样板收口（各端点不再手写 getConnInfo try/catch 与 headers 提取）。
// ─────────────────────────────────────────────────────────────────────────────

/** 从请求上下文取不可伪造的 socket 对端地址；无连接信息（app.request 测试等）→ null */
export function socketAddressFromContext(c: Context): string | null {
  try {
    return getConnInfo(c).remote?.address ?? null;
  } catch {
    return null;
  }
}

/**
 * 从 Hono 上下文提取客户端 IP（@hono/node-server 部署形态）。
 * config 只需含 trustedProxyHops（admin/client 两面 config 均结构兼容）。
 */
export function clientIpFromContext(
  c: Context,
  config: { trustedProxyHops: number },
): string {
  return trustedClientIp({
    headers: c.req.raw.headers,
    trustedProxyHops: config.trustedProxyHops,
    socketAddress: socketAddressFromContext(c),
  });
}
