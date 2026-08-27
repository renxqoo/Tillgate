/**
 * 用户路由（资料面）：列表（钱包富化 + 企业过滤）/资料/补丁
 * （封禁语义;creditLimit 拆给 wallet.setCreditLimit——app 组合,非第二套规则）/
 * set-password（管理员为本地账号重置密码——绑默认卡「标准」+ 全网会话下线）。
 * 响应体永不包括 passwordHash（服务列白名单,测试红线锁定）。
 */
import { Hono } from 'hono';
import type { AccountUseCases } from '@tillgate/accounts';
import type { WalletApi } from '@tillgate/billing';
import type { Identity } from '@tillgate/identity';
import type { ControlPlane } from '@tillgate/control-plane';
import { AdminErrors } from '../error-face';
import type { SessionEnv } from '../middleware/session';
import { controlContextOf } from '../middleware/session';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { USER_SORTS, usersContracts } from '../contracts/users';
import { toUserWireRow, walletEnrichmentOf } from '../presenters/users';
import { authContracts } from '../contracts/auth';
import type { PostAudit } from './redeem';

/** 默认费率卡名（词表事实,装配不复制第二份语义） */
const DEFAULT_RATE_CARD_NAME = '标准';

/** 路由依赖（facade 结构子集——测试注入替身） */
export interface UsersRoutesDeps {
  readonly accounts: Pick<AccountUseCases, 'adminListUsers' | 'adminGetUser' | 'adminPatchUser'>;
  readonly wallet: Pick<WalletApi, 'accounts' | 'setCreditLimit'>;
  /** 密码重置（identity user realm 单一真相）+ 默认卡绑定 */
  readonly identity: Pick<Identity, 'passwords'>;
  readonly rates: Pick<ControlPlane['rates'], 'listCards' | 'updateCard' | 'findGlobalCoefficient'>;
  /** 后置审计（user.set_password——提交后旁路,失败不阻断） */
  readonly postAudit: PostAudit;
}

// eslint-disable-next-line max-lines-per-function -- 路由表装配平铺:注册即数据,内联处理器为既有语义
export function usersRoutes(deps: UsersRoutesDeps) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/users', async (c) => {
    const extra = usersContracts.listQueryExtra.parse(c.req.query());
    const query = parseListQuery(c.req.query(), USER_SORTS, 'createdAt');
    const page = await deps.accounts.adminListUsers({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(extra.status !== undefined ? { status: extra.status } : {}),
      ...(extra.enterprise !== undefined ? { enterprise: extra.enterprise === '1' } : {}),
      sort: query.sortBy,
      order: query.order,
      page: query.page,
      limit: query.limit,
    });
    const rows = await Promise.all(
      page.rows.map(async (row) =>
        toUserWireRow(
          row,
          walletEnrichmentOf(await deps.wallet.accounts(row.id)),
          row.rateCardName,
        ),
      ),
    );
    return c.json(listEnvelope(rows, page.total, query));
  });

  app.get('/v1/users/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const profile = await deps.accounts.adminGetUser(id);
    return c.json(
      toUserWireRow(
        profile,
        walletEnrichmentOf(await deps.wallet.accounts(id)),
        profile.rateCardName,
      ),
    );
  });

  app.patch('/v1/users/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = usersContracts.patch.parse(await c.req.json());
    const { creditLimit, ...patch } = body;
    await deps.accounts.adminPatchUser({
      userId: id,
      patch,
      adminId: c.get('adminId'),
    });
    if (creditLimit !== undefined) {
      await deps.wallet.setCreditLimit({ userId: id, amount: creditLimit });
    }
    return c.json({ id });
  });

  app.post('/v1/users/:id/set-password', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = authContracts.setPassword.parse(await c.req.json());
    const profile = await deps.accounts.adminGetUser(id);
    // 只能为本地账号设密：给 OIDC 身份挂本地密码 = 管理员接管
    if (profile.issuer !== 'local') {
      throw AdminErrors.business('not_local_account', {});
    }
    // 未绑卡 → 绑默认卡「标准」；缺全局兜底系数则回填 1.000
    // （已有系数不覆盖——findGlobalCoefficient 判存后才 update）
    if (profile.rateCardId == null) {
      const cards = await deps.rates.listCards({
        sortBy: 'id',
        order: 'asc',
        limit: 100,
        offset: 0,
      });
      const standard = cards.rows.find((card) => card.name === DEFAULT_RATE_CARD_NAME);
      if (standard != null) {
        if ((await deps.rates.findGlobalCoefficient(standard.id)) == null) {
          await deps.rates.updateCard({
            ctx: controlContextOf(c),
            rateCardId: standard.id,
            patch: { coefficient: '1.000' },
          });
        }
        await deps.accounts.adminPatchUser({
          userId: id,
          patch: { rateCardId: standard.id },
          adminId: c.get('adminId'),
        });
      }
    }
    // 密码重置 = identity user realm（策略单源校验 + 推进锚点线 = 全网旧会话即刻下线）
    await deps.identity.passwords.reset({
      userId: id,
      realm: 'user',
      newPassword: body.password,
    });
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'user.set_password',
      targetType: 'user',
      targetId: id,
      detail: null,
    });
    return c.json({ ok: true });
  });

  return app;
}
