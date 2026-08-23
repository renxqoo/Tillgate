/**
 * 管理员自身路由（P2;v1 routes/me.ts 平移,会话组）：资料/改密/2FA 开关/TOTP。
 * 改密 = identity.passwords.change（验旧密入锁内 B04 + 推进 admin realm 失效线 =
 * 全网旧会话即刻下线）→ 同拍新 token（iat 严格在线后——identity clock 单源）。
 * 2FA 开关 = 邮箱验证码（旧形态,SMTP 前置 fail-closed）;TOTP = 验证器 App
 * （挂起→扫码→验码确认→恢复码;绑定即接管第二因子,登录不再退回邮箱码防降级）。
 */
import { Hono } from 'hono';
import { jsonBody } from '@tokenlens/http';
import type { MiddlewareHandler } from 'hono';
import type { Identity } from '@tokenlens/identity';
import type { ControlPlane } from '@tokenlens/control-plane';
import { AdminErrors } from '../error-face';
import type { SessionEnv } from '../middleware/session';
import { authContracts } from '../contracts/auth';

export interface MeRoutesDeps {
  readonly identity: Pick<Identity, 'passwords' | 'sessions' | 'mfa'>;
  readonly admins: Pick<ControlPlane['admins'], 'find' | 'setTwoFactorEnabled'>;
  readonly mailerConfigured: boolean;
  readonly sessionTtlSec: number;
}

export function meRoutes(deps: MeRoutesDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/me', session, async (c) => {
    const adminId = c.get('adminId');
    const me = await deps.admins.find(adminId);
    if (me == null) {
      // 会话有效但资料行缺失（迁移不完整）——与 v1 同口径 401,不泄漏状态
      throw AdminErrors.business('admin_not_found', {});
    }
    const totp = await deps.identity.mfa.status({ userId: adminId });
    return c.json({
      id: me.id,
      email: me.email,
      displayName: me.displayName,
      twoFactorEnabled: me.twoFactorEnabled,
      totpEnabled: totp.confirmed,
      lastLoginAt: me.lastLoginAt,
    });
  });

  app.post('/v1/me/password', session, async (c) => {
    const body = authContracts.changePassword.parse(await c.req.json());
    await deps.identity.passwords.change({
      userId: c.get('adminId'),
      realm: 'admin',
      currentPassword: body.oldPassword,
      newPassword: body.newPassword,
    });
    return c.json({
      token: await deps.identity.sessions.sign({
        realm: 'admin',
        subjectId: c.get('adminId'),
        ttlSec: deps.sessionTtlSec,
      }),
    });
  });

  app.post('/v1/me/two-factor', session, async (c) => {
    const body = authContracts.twoFactor.parse(await c.req.json());
    if (body.enabled && !deps.mailerConfigured) {
      throw AdminErrors.business('smtp_not_configured', {});
    }
    await deps.admins.setTwoFactorEnabled({ adminId: c.get('adminId'), enabled: body.enabled });
    return c.json({ twoFactorEnabled: body.enabled });
  });

  // TOTP 挂起注册:返回 base32 密钥 + otpauth URL(仅本次;扫码确认前不参与登录)
  app.post('/v1/me/totp/enroll', session, async (c) => {
    const me = await deps.admins.find(c.get('adminId'));
    const result = await deps.identity.mfa.enrollTotp({
      userId: c.get('adminId'),
      label: me?.email,
    });
    return c.json(result);
  });

  // 确认绑定:验当前验证器码 → 生效 + 整组重签恢复码(仅此一次返回明文)
  app.post('/v1/me/totp/confirm', session, jsonBody(authContracts.totpCode), async (c) => {
    const body = c.req.valid('json');
    const result = await deps.identity.mfa.confirmTotp({
      userId: c.get('adminId'),
      code: body.code,
    });
    return c.json(result);
  });

  // 解绑:必须持有效 TOTP/恢复码(防会话被偷后一键拆防线)
  app.post('/v1/me/totp/disable', session, jsonBody(authContracts.totpCode), async (c) => {
    const body = c.req.valid('json');
    const result = await deps.identity.mfa.disableTotp({
      userId: c.get('adminId'),
      code: body.code,
    });
    if (!result.disabled) {
      throw AdminErrors.business('invalid_totp_code', {});
    }
    return c.json({ ok: true });
  });

  return app;
}
