/**
 * 管理员管理路由（RBAC admins 域——super_admin 专属）。
 *
 * 创建 = 邀请制（三动词编排,两包无共享事务边界,失败补偿）：
 *   1. control-plane 建资料行（admin id ≥1e9 段分配 + role 落库）
 *   2. identity 注册 email 凭据（不带密码——初始密码由本人经邮件一次性链接设置）
 *   3. 凭据被占（identifier_taken——邮箱被任何身份占用）→ 补偿删资料行 → 409 同码
 *      （绝不留「创建成功但永远登不上」的废号;create-admin 脚本同口径）
 *   4. 尽力投递邀请邮件（SMTP/链接基地未生效或投递失败 → inviteSent:false 不回滚：
 *      补偿 remove 只删资料行不级联凭据,回滚会留孤儿 identifier 死锁同邮箱重建;
 *      数据终态自洽,列表「重发邀请」补救——docs/admin-invite/DESIGN.md）
 *   5. 全部落定才旁路审计（postAudit——detail 含 inviteSent 如实记录）
 *
 * 重发邀请 = 60s 冷却(Redis SET NX,发送前占用;投递失败不释放——防 SMTP 故障
 * 连点重发打爆发件通道) + 前置校验(已设密码/封禁不可发)。
 * 更新 = role/status/displayName 部分更新;「不可改自身 role/status」守卫在此
 * （会话身份是路由的知识——防最后一个超管自锁）。
 */
import { Hono } from 'hono';
import { isBusinessError } from '@tillgate/errors';
import { controlPlaneErrors, type AdminRecord, type ControlPlane } from '@tillgate/control-plane';
import type { Identity } from '@tillgate/identity';
import { parseAcceptLanguage } from '@tillgate/http';
import { AdminErrors } from '../error-face';
import type { SessionEnv } from '../middleware/session';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { adminsContracts } from '../contracts/admins';
import type { PostAudit } from './redeem';

/** 排序白名单（sort_by 词表外 400 admin.invalid_sort_field——统一列表契约） */
const ADMIN_SORTS = ['id', 'email', 'lastLoginAt', 'createdAt'] as const;

/**
 * 邀请令牌 + 冷却面（结构形状——adapters/redis-admin-invite 的装配注入形;
 * 路由不引用 adapter,与 AuthGuard 同口径）。consume 在 auth 域
 * POST /v1/auth/reset-password 消费（形状子集经 AuthRoutesDeps 注入）。
 */
export interface AdminInvitePort {
  /** 签发一次性令牌明文(仅本次返回,入库只存哈希;TTL 30 分钟) */
  issue(adminId: number): Promise<string>;
  /** 原子单次消费;有效返回 adminId,无效/过期/已用返回 null */
  consume(token: string): Promise<number | null>;
  /** 重发冷却占用(60s SET NX);true=占用成功可发,false=冷却中 */
  tryStartCooldown(adminId: number): Promise<boolean>;
}

export interface AdminsRoutesDeps {
  /** admins 资料面动词（list/create/update/remove/find） */
  admins: Pick<ControlPlane['admins'], 'list' | 'create' | 'update' | 'remove' | 'find'>;
  /** 凭据注册(email 标识) + 密码读面(激活态投影);策略单源校验在 identity 内 */
  identity: Pick<Identity, 'credentials' | 'passwords'>;
  postAudit: PostAudit;
  /** 邀请令牌 + 重发冷却(Redis 适配器,装配注入) */
  invites: AdminInvitePort;
  /** 邀请邮件投递(ttl 由装配闭包注入;SMTP 未生效抛 undeliverable_challenge) */
  sendInviteLink: (to: string, url: string, ctx: { locale?: 'en' | 'zh' }) => Promise<void>;
  /** 管理后台前端基地址(null = ADMIN_FRONTEND_URL 未配置,邀请链接不可拼) */
  inviteLinkBase: string | null;
  /** SMTP 快照是否生效(邀请投递前置判定) */
  mailerConfigured: () => boolean;
}

/** wire 形状（列表/创建/更新共用的资料投影——不含密码/2FA 密钥列;
 *  hasPassword = 激活态(待激活 = 需要邀请邮件/重发按钮显隐单一事实) */
function adminRowOf(record: AdminRecord, hasPassword: boolean) {
  return {
    id: record.id,
    email: record.email,
    displayName: record.displayName,
    roleId: record.roleId,
    role: record.role,
    status: record.status,
    twoFactorEnabled: record.twoFactorEnabled,
    lastLoginAt: record.lastLoginAt,
    createdAt: record.createdAt,
    hasPassword,
  };
}

/** 邮件 locale 跟随触发请求(操作者界面语言,中英模板兜底英文) */
const localeOf = (headers: Headers): 'en' | 'zh' =>
  parseAcceptLanguage(headers.get('accept-language')) === 'zh' ? 'zh' : 'en';

// eslint-disable-next-line max-lines-per-function -- 路由表装配平铺:注册即数据,内联处理器保留存量语义(棘轮)
export function adminsRoutes(deps: AdminsRoutesDeps) {
  const app = new Hono<SessionEnv>();

  /**
   * 创建路径的尽力投递:SMTP/链接基地未生效或投递失败返回 false(不抛——
   * 创建不因邮件通道回滚,inviteSent:false 由列表重发补救)
   */
  const deliverInvite = async (
    adminId: number,
    to: string,
    locale: 'en' | 'zh',
  ): Promise<boolean> => {
    if (deps.inviteLinkBase == null || !deps.mailerConfigured()) return false;
    const token = await deps.invites.issue(adminId);
    const url = `${deps.inviteLinkBase}/reset-password?token=${encodeURIComponent(token)}`;
    try {
      await deps.sendInviteLink(to, url, { locale });
    } catch {
      return false;
    }
    return true;
  };

  app.get('/v1/admins', async (c) => {
    const query = parseListQuery(c.req.query(), ADMIN_SORTS, 'id');
    const page = await deps.admins.list({
      ...(query.q !== undefined ? { q: query.q } : {}),
      sortBy: query.sortBy as 'id' | 'email' | 'lastLoginAt' | 'createdAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    // 激活态批量投影(单条 IN 查询防 N+1;空页免查)
    const withPassword = new Set(
      page.rows.length > 0
        ? await deps.identity.passwords.exists({ userIds: page.rows.map((row) => row.id) })
        : [],
    );
    return c.json(
      listEnvelope(
        page.rows.map((row) => adminRowOf(row, withPassword.has(row.id))),
        page.total,
        query,
      ),
    );
  });

  app.post('/v1/admins', async (c) => {
    const body = adminsContracts.create.parse(await c.req.json());
    const created = await deps.admins.create({
      email: body.email,
      displayName: body.displayName ?? null,
      roleId: body.roleId,
    });
    try {
      await deps.identity.credentials.register({
        userId: created.id,
        identifier: { kind: 'email', value: created.email },
      });
    } catch (error) {
      // 补偿收回资料行——凭据没注册成功的管理员是废号,不留孤儿
      await deps.admins.remove(created.id).catch(() => {});
      if (isBusinessError(error) && error.code === 'identity.identifier_taken') {
        throw controlPlaneErrors.business('admin_email_taken', {
          email: created.email,
          source: 'identity',
        });
      }
      throw error;
    }
    const inviteSent = await deliverInvite(created.id, created.email, localeOf(c.req.raw.headers));
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'admin.created',
      targetType: 'admin',
      targetId: created.id,
      detail: { email: created.email, roleId: created.roleId, inviteSent },
    });
    return c.json({ ...adminRowOf(created, false), inviteSent }, 201);
  });

  // 重发邀请:前置校验(404/409/403/503) → 冷却占用(429) → 签发+投递 → 审计
  app.post('/v1/admins/:id/resend-invite', async (c) => {
    const id = idParam(c.req.param('id'));
    const admin = await deps.admins.find(id);
    if (admin == null) {
      throw AdminErrors.business('admin_not_found', { adminId: id });
    }
    // 已设密码 = 已激活,邀请链接(设置初始密码)无意义
    const activated = await deps.identity.passwords.exists({ userIds: [id] });
    if (activated.length > 0) {
      throw AdminErrors.business('admin_invite_not_needed', { adminId: id });
    }
    if (admin.status !== 0) {
      throw AdminErrors.business('account_unavailable', { adminId: id });
    }
    if (deps.inviteLinkBase == null || !deps.mailerConfigured()) {
      throw AdminErrors.business('admin_invite_link_unavailable', {});
    }
    if (!(await deps.invites.tryStartCooldown(id))) {
      throw AdminErrors.business('admin_invite_rate_limited', { 'retry-after': '60' });
    }
    const token = await deps.invites.issue(id);
    const url = `${deps.inviteLinkBase}/reset-password?token=${encodeURIComponent(token)}`;
    // 投递失败冒泡(冷却保留,60s 后可再试);不哑成功——操作员须知道没发出去
    await deps.sendInviteLink(admin.email, url, { locale: localeOf(c.req.raw.headers) });
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'admin.invite_resent',
      targetType: 'admin',
      targetId: id,
      detail: { email: admin.email },
    });
    return c.json({ ok: true });
  });

  app.patch('/v1/admins/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = adminsContracts.patch.parse(await c.req.json());
    // 自改守卫：roleId/status 不可改自身（displayName 可改——无权限面影响）
    if (id === c.get('adminId') && (body.roleId !== undefined || body.status !== undefined)) {
      throw AdminErrors.business('cannot_modify_self', {});
    }
    const updated = await deps.admins.update({
      adminId: id,
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.roleId !== undefined ? { roleId: body.roleId } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    });
    if (updated == null) {
      throw AdminErrors.business('admin_not_found', { adminId: id });
    }
    const [hasPassword] = await deps.identity.passwords.exists({ userIds: [id] });
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'admin.updated',
      targetType: 'admin',
      targetId: id,
      detail: {
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.roleId !== undefined ? { roleId: body.roleId } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
    });
    return c.json(adminRowOf(updated, hasPassword != null));
  });

  return app;
}
