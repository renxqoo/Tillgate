/**
 * Cloudflare Turnstile 适配器(注册面防刷)。威胁模型:分布式刷号薅首登赠额、
 * 跨受害者邮箱骚扰;managed 隐形挑战下合法用户零交互。
 * 错误二分:客户端过错码(票据缺失/伪造/过期/重放)→ invalid;空码表/未知码/
 * 配置过错/网络失败/非 200/非 JSON → unavailable(fail-closed,防「打瘫厂商免验证」)。
 */
import type { Captcha } from '../../ports/captcha.js';

/** 可注入 fetch(bun 类型加宽了全局 fetch——注入面收窄为可调用视图) */
type FetchLike = (...args: Parameters<typeof fetch>) => Promise<Response>;

export interface TurnstileCaptchaOptions {
  readonly siteKey: string;
  readonly secretKey: string;
  /** 覆盖 siteverify 地址(测试注入/私有化) */
  readonly verifyUrl?: string;
  /** 覆盖 fetch(测试注入) */
  readonly fetchImpl?: FetchLike;
  /** siteverify 超时毫秒(必填注入,铁律 3) */
  readonly timeoutMs: number;
}

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** 客户端过错码——归因用户而非服务端 */
const CLIENT_FAULT_CODES = new Set([
  'missing-input-response',
  'invalid-input-response',
  'timeout-or-duplicate',
  'invalid-or-already-seen-response',
]);

interface SiteverifyResponse {
  success?: boolean;
  'error-codes'?: string[];
}

export function createTurnstileCaptcha(
  opts: TurnstileCaptchaOptions,
): Captcha & { siteKey: string } {
  const verifyUrl = opts.verifyUrl ?? TURNSTILE_VERIFY_URL;
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    siteKey: opts.siteKey,
    async verify({ token, remoteIp }) {
      const trimmed = token.trim();
      if (!trimmed) return { ok: false, reason: 'invalid' };
      let res: Response;
      try {
        res = await doFetch(verifyUrl, {
          method: 'POST',
          body: new URLSearchParams({
            secret: opts.secretKey,
            response: trimmed,
            ...(remoteIp ? { remoteip: remoteIp } : {}),
          }),
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      if (!res.ok) return { ok: false, reason: 'unavailable' };
      let body: SiteverifyResponse;
      try {
        body = (await res.json()) as SiteverifyResponse;
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      if (body.success === true) return { ok: true };
      const codes = body['error-codes'] ?? [];
      // 全部为已知客户端过错才归因用户;空码表/未知码/配置过错一律 unavailable(fail-closed)
      if (codes.length > 0 && codes.every((code) => CLIENT_FAULT_CODES.has(code))) {
        return { ok: false, reason: 'invalid' };
      }
      return { ok: false, reason: 'unavailable' };
    },
  };
}
