/**
 * 注册动词（公开，恒两步制——v1 语义）：register 发码（载荷只存 cipher 封装后的
 * 密码，永不落明文）→ register/verify 建号 + 绑凭据 + 建号收尾（赠送/归因
 * best-effort）+ 签发会话。闸序：开关 → IP 限频 → captcha → 邮箱占用 → 密码策略。
 */
import { Hono } from 'hono';
import { AccountsErrors } from '@tokenlens/accounts';
import { jsonBody } from '@tokenlens/http';
import { assertPasswordPolicy } from '@tokenlens/identity';
import { registerSchema, verifySchema } from '../contracts/auth.js';
import { clientErrors } from '../error-face.js';
import type { SessionEnv } from '../middleware/session.js';
import { clientIpOf, localeOf, type AuthDeps } from './auth.js';

/** 注册期挑战载荷（identity challenges.payload 的 app 形状） */
interface RegisterPayload {
  mail: string;
  aff: string | null;
  pwd: string;
}

export function registerRoutes(deps: AuthDeps) {
  const app = new Hono<SessionEnv>();

  app.post('/v1/auth/register', jsonBody(registerSchema), async (c) => {
    const body = c.req.valid('json');
    const ip = clientIpOf(deps, c);
    if (!deps.capabilities.registerEnabled) {
      throw clientErrors.business('register_disabled');
    }
    let hits: number;
    try {
      hits = await deps.registerLimiter.hit(`register:${ip}`, deps.registerWindowSeconds);
    } catch {
      throw clientErrors.business('rate_counter_unavailable');
    }
    if (hits > deps.registerIpLimitPerHour) {
      throw clientErrors.business('register_rate_limited', undefined, {
        retryAfterMs: deps.registerWindowSeconds * 1_000,
      });
    }
    if (deps.captcha != null && deps.capabilities.captchaSiteKey != null) {
      if (body.captchaToken == null) {
        throw clientErrors.business('captcha_required');
      }
      // 判负/不可达由 identity 翻译为业务错误（captcha_invalid 400 / captcha_unavailable 503）
      await deps.captcha.verify({ token: body.captchaToken, remoteIp: ip ?? undefined });
    }
    if (await deps.emailTaken(body.email)) {
      throw AccountsErrors.business('email_taken', { email: body.email });
    }
    // 密码策略单源校验（identity 域；不满足直接 400——v1 在发码前拒绝）
    assertPasswordPolicy(body.password, deps.passwordPolicy);
    const payload: Record<string, unknown> = {
      mail: body.email,
      aff: body.aff ?? null,
      pwd: deps.sealer.seal(body.password),
    };
    const { challengeId } = await deps.challenges.begin({
      kind: 'email_code',
      target: { identifier: { kind: 'email', value: body.email } },
      payload,
      delivery: { ip: ip ?? 'unknown', locale: localeOf(c) },
    });
    return c.json({ kind: 'code_required', challengeId });
  });

  app.post('/v1/auth/register/verify', jsonBody(verifySchema), async (c) => {
    const body = c.req.valid('json');
    if (!deps.capabilities.registerEnabled) {
      throw clientErrors.business('register_disabled');
    }
    const verified = await deps.challenges.verify({
      challengeId: body.challengeId,
      code: body.code,
    });
    const payload = (verified.payload ?? {}) as Partial<RegisterPayload>;
    if (payload.mail == null || payload.pwd == null) {
      // 挑战载荷损坏 = 装配期坏流（非用户错误），显式 503 不静默吞
      throw clientErrors.business('two_factor_unavailable');
    }
    const user = await deps.provision({ email: payload.mail });
    await deps.registerCredential({
      userId: user.id,
      identifier: { kind: 'email', value: payload.mail },
      password: deps.sealer.open(payload.pwd),
    });
    const onboarding = await deps.onboarding({
      userId: user.id,
      affCode: body.aff ?? payload.aff ?? undefined,
    });
    const token = await deps.sign(user.id);
    return c.json(
      {
        kind: 'success',
        token,
        userId: user.id,
        email: user.email ?? payload.mail,
        gifted: onboarding.gift.status === 'credited',
      },
      201,
    );
  });

  return app;
}
