import { CaptchaError } from './errors.js';

/**
 * 人机验证组件（Cloudflare Turnstile）——注册面防刷的单一实现。
 *
 * 威胁模型：分布式刷号（僵尸网络摊薄每 IP 注册限流）薅首登赠额、跨受害者邮箱骚扰。
 * 选型隐形挑战（managed 模式）：合法用户零交互，攻击者难以规模化代解；
 * token 由浏览器 widget 产生、经 BFF 原样转发——服务间调用不代答（否则机器人
 * 调 server action 即可绕过），仅持 x-internal-token 的可信内部调用豁免（路由层判定）。
 *
 * 错误约定：失败抛 CaptchaError（reason: invalid/unavailable，语义分级见 errors.ts），
 * 成功返回 void；消费方在边界 catch 后映射 400/503，不得裸冒。
 */

export interface CaptchaService {
  /** 公开 siteKey（GET /api/auth/captcha 下发给前端渲染 widget） */
  siteKey: string;
  /** 服务端验签：token 由浏览器 widget 产生；失败抛 CaptchaError */
  verify(input: { token: string; remoteIp?: string }): Promise<void>;
}

export interface TurnstileCaptchaOptions {
  siteKey: string;
  secretKey: string;
  /** 覆盖 siteverify 地址（测试注入） */
  verifyUrl?: string;
  /** 覆盖 fetch（测试注入） */
  fetchImpl?: typeof fetch;
  /** siteverify 超时毫秒（默认 5s） */
  timeoutMs?: number;
}

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 5_000;

/** 客户端过错码（票据缺失/伪造/过期/重放）——归因用户而非服务端 */
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

export function createTurnstileCaptcha(opts: TurnstileCaptchaOptions): CaptchaService {
  const verifyUrl = opts.verifyUrl ?? TURNSTILE_VERIFY_URL;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;
  return {
    siteKey: opts.siteKey,
    async verify({ token, remoteIp }) {
      const trimmed = token.trim();
      if (!trimmed) throw new CaptchaError('invalid');
      let res: Response;
      try {
        res = await doFetch(verifyUrl, {
          method: 'POST',
          body: new URLSearchParams({
            secret: opts.secretKey,
            response: trimmed,
            ...(remoteIp ? { remoteip: remoteIp } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new CaptchaError('unavailable');
      }
      if (!res.ok) throw new CaptchaError('unavailable');
      let body: SiteverifyResponse;
      try {
        body = (await res.json()) as SiteverifyResponse;
      } catch {
        throw new CaptchaError('unavailable');
      }
      if (body.success === true) return;
      const codes = body['error-codes'] ?? [];
      // 全部为已知客户端过错才归因用户；空码表/未知码/配置过错一律 unavailable（fail-closed）
      if (codes.length > 0 && codes.every((code) => CLIENT_FAULT_CODES.has(code))) {
        throw new CaptchaError('invalid');
      }
      throw new CaptchaError('unavailable');
    },
  };
}

/** 从 env 装配：成对配置才启用；只配置一半 → 抛错（安全控制不许静默半开） */
export function captchaFromEnv(env: { CAPTCHA_SITE_KEY?: string; CAPTCHA_SECRET_KEY?: string }): CaptchaService | null {
  const siteKey = env.CAPTCHA_SITE_KEY?.trim();
  const secretKey = env.CAPTCHA_SECRET_KEY?.trim();
  if (!siteKey && !secretKey) return null;
  if (!siteKey || !secretKey) {
    throw new Error('CAPTCHA_SITE_KEY 与 CAPTCHA_SECRET_KEY 必须成对配置（只配一半 = 人机验证静默半开，拒绝启动）');
  }
  return createTurnstileCaptcha({ siteKey, secretKey });
}
