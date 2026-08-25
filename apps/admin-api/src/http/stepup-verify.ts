/**
 * 敏感设置操作的 TOTP step-up 强制点（ADR-0011）：验证当前会话管理员的
 * 6 位验证器码。未绑定 → totp_stepup_required（403，引导先绑定验证器）；
 * 错码 → invalid_totp_code + IP 守卫错次（登录面同口径，防 6 位码空间爆破）
 * + 失败审计。前端弹窗只是 UI 面——强制点在此，绕过 UI 直调 API 同样被拒。
 * 消费面：settings 集成写入（PUT /v1/settings/integrations/:key）与
 * 2FA 邮箱开关（POST /v1/me/two-factor）。
 */
import type { Context } from 'hono';
import { isBusinessError } from '@tillgate/errors';
import { socketAddressFromContext, trustedClientIp } from '@tillgate/http';
import type { Identity } from '@tillgate/identity';
import { AdminErrors } from './error-face';
import type { AuthGuard } from './routes/auth';
import type { SessionEnv } from './middleware/session';

export interface StepupVerifyDeps {
  readonly identity: Pick<Identity, 'mfa'>;
  readonly guards: { readonly ip: AuthGuard };
  /** step-up 失败审计（observability writeAudit 同装置，action 自由词面） */
  readonly audit: (entry: {
    action: string;
    adminId: number;
    ip: string | null;
  }) => Promise<unknown>;
  readonly trustedProxyHops: number;
}

/**
 * 验证通过才放行；code 由调用方从已过契约校验的请求体取出传入。
 * 6 位码空间小——错码必须计守卫错次（防在线爆破），锁定由守卫统一判定。
 */
export async function requireTotpStepup(
  deps: StepupVerifyDeps,
  c: Context<SessionEnv>,
  code: string,
): Promise<void> {
  const adminId = c.get('adminId');
  const ip = trustedClientIp({
    headers: c.req.raw.headers,
    trustedProxyHops: deps.trustedProxyHops,
    socketAddress: socketAddressFromContext(c),
  });
  try {
    await deps.identity.mfa.verifyTotpOnly({ userId: adminId, code });
  } catch (error) {
    if (isBusinessError(error) && error.code === 'identity.totp_not_enrolled') {
      throw AdminErrors.business('totp_stepup_required', {});
    }
    if (isBusinessError(error) && error.code === 'identity.invalid_totp_code') {
      await Promise.allSettled([deps.guards.ip.recordFailure(ip)]);
      await deps.audit({ action: 'settings.stepup.failed', adminId, ip }).catch(() => {});
      throw AdminErrors.business('invalid_totp_code', {});
    }
    throw error;
  }
}
