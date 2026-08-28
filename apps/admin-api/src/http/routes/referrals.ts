/**
 * 邀请管理路由：关系列表（双方邮箱/状态）、
 * 作弊封禁/恢复、三类返利流水（佣金/邀请注册奖励/注册赠送——wallet 流水投影）。
 * 封禁语义：worker 停止派奖（inviterActive 已消费）,历史入账不动。
 * 关系列表不含 wallet 投影（commissionTotal 不出列,
 * 资金投影走 payouts 端点,billing referralPayouts 单一真相）。
 */
import { Hono } from 'hono';
import type { AccountUseCases } from '@tillgate/accounts';
import type { WalletApi } from '@tillgate/billing';
import { AdminErrors } from '../error-face';
import type { SessionEnv } from '../middleware/session';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { REFERRAL_KINDS, referralContracts } from '../contracts/marketing';

export interface ReferralRoutesDeps {
  readonly accounts: Pick<AccountUseCases, 'listReferralRelations' | 'setReferralRelationStatus'>;
  readonly wallet: Pick<WalletApi, 'referralPayouts'>;
}

export function referralRoutes(deps: ReferralRoutesDeps) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/referrals/relations', async (c) => {
    const query = parseListQuery(c.req.query(), ['id'], 'id');
    const page = await deps.accounts.listReferralRelations({
      ...(query.q !== undefined ? { q: query.q } : {}),
      page: query.page,
      limit: query.limit,
    });
    return c.json(listEnvelope([...page.rows], page.total, query));
  });

  app.patch('/v1/referrals/relations/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = referralContracts.patchRelation.parse(await c.req.json());
    return c.json(
      await deps.accounts.setReferralRelationStatus({
        relationId: id,
        status: body.status,
        adminId: c.get('adminId'),
      }),
    );
  });

  app.get('/v1/referrals/payouts', async (c) => {
    const kind = c.req.query('kind');
    if (!REFERRAL_KINDS.includes(kind as (typeof REFERRAL_KINDS)[number])) {
      throw AdminErrors.business('invalid_param', {
        field: 'kind',
        reason: `must be one of ${REFERRAL_KINDS.join(', ')}`,
      });
    }
    const query = parseListQuery(c.req.query(), ['id'], 'id');
    const page = await deps.wallet.referralPayouts({
      kind: kind as (typeof REFERRAL_KINDS)[number],
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(page.rows, page.total, query));
  });

  return app;
}
