/**
 * 管理员自身路由（P2;v1 routes/me.ts 平移,会话组）：资料/改密/2FA 开关。
 * 改密 = identity.passwords.change（验旧密入锁内 B04 + 推进 admin realm 失效线 =
 * 全网旧会话即刻下线）→ 同拍新 token（iat 严格在线后——identity clock 单源）。
 * 2FA 开启前置 SMTP（fail-closed,绝不静默降级单密码——v1 语义）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { Identity } from '@tokenlens/identity';
import type { ControlPlane } from '@tokenlens/control-plane';
import { AdminErrors } from '../error-face';
import type { SessionEnv } from '../middleware/session';
import { authContracts } from '../contracts/auth';

export interface MeRoutesDeps {
  readonly identity: Pick<Identity, 'passwords' | 'sessions'>;
  readonly admins: Pick<ControlPlane['admins'], 'find' | 'setTwoFactorEnabled'>;
  readonly mailerConfigured: boolean;
  readonly sessionTtlSec: number;
}

export function meRoutes(deps: MeRoutesDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/me', session, async (c) => {
    const me = await deps.admins.find(c.get('adminId'));
    if (me == null) {
      // 会话有效但资料行缺失（迁移不完整）——与 v1 同口径 401,不泄漏状态
      throw AdminErrors.business('admin_not_found', {});
    }
    return c.json({
      id: me.id,
      email: me.email,
      displayName: me.displayName,
      twoFactorEnabled: me.twoFactorEnabled,
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

  return app;
}
