/**
 * Cloudflare Turnstile 人机验证（identity Captcha port 的 HTTP 实现）。
 * 网络故障/非 2xx = unavailable（fail-closed——不静默放行）；判负 = invalid。
 */
import type { Captcha } from '@tillgate/identity';

export interface TurnstileConfig {
  secretKey: string;
  /** siteverify 端点（默认官方；私有化代理/测试 mock 注入覆盖） */
  verifyUrl: string;
}

export function createTurnstileCaptcha(config: TurnstileConfig): Captcha {
  return {
    async verify({ token, remoteIp }) {
      try {
        const body = new URLSearchParams({
          secret: config.secretKey,
          response: token,
          ...(remoteIp != null ? { remoteip: remoteIp } : {}),
        });
        const res = await fetch(config.verifyUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        });
        if (!res.ok) return { ok: false as const, reason: 'unavailable' as const };
        const data = (await res.json()) as { success?: boolean };
        return data.success === true
          ? { ok: true as const }
          : { ok: false as const, reason: 'invalid' as const };
      } catch {
        return { ok: false as const, reason: 'unavailable' as const };
      }
    },
  };
}
