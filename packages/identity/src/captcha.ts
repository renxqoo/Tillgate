/**
 * 人机验证组件（Cloudflare Turnstile）——注册面防刷的单一实现。
 *
 * 威胁模型：分布式刷号（僵尸网络摊薄每 IP 注册限流）薅首登赠额、跨受害者邮箱骚扰。
 * 选型隐形挑战（managed 模式）：合法用户零交互，攻击者难以规模化代解；
 * token 由浏览器 widget 产生、经 BFF 原样转发——服务间调用不代答（否则机器人
 * 调 server action 即可绕过），仅持 x-internal-token 的可信内部调用豁免（路由层判定）。
 *
 * 结果语义分级（消费方为路由层，映射 400/503）：
 *   - invalid     → 票据缺失/伪造/过期/重放：客户端过错，可换新票重试
 *   - unavailable → 厂商 API 不可达/我方配置过错：fail-closed 绝不放行（503），
 *                   防「打瘫厂商即可免验证」的旁路
 */
export interface CaptchaVerifyOutcome {
  ok: boolean;
  reason?: 'invalid' | 'unavailable';
}

export interface CaptchaService {
  /** 公开 siteKey（GET /api/auth/captcha 下发给前端渲染 widget） */
  siteKey: string;
  /** 服务端验签：token 由浏览器 widget 产生 */
  verify(input: { token: string; remoteIp?: string }): Promise<CaptchaVerifyOutcome>;
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
          signal: AbortSignal.timeout(timeoutMs),
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
      // 全部为已知客户端过错才归因用户；空码表/未知码/配置过错一律 unavailable（fail-closed）
      if (codes.length > 0 && codes.every((code) => CLIENT_FAULT_CODES.has(code))) {
        return { ok: false, reason: 'invalid' };
      }
      return { ok: false, reason: 'unavailable' };
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
