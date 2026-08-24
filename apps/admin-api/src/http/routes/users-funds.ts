/**
 * 用户资金路由（v1 funds.service 编排的 app 组合面）：调账（可负）/赠送/
 * 钱包流水/用户审计。幂等走 billing operations 用例（同键同参重放回执、异参 409）;
 * 资金审计与业务同事务（writeAudit 装配闭包——G1 桥,tx 由 operations 注入）。
 * 负数调账 = 扣款到外部世界镜像（allowCredit:true——授信地板内可负,地板由 wallet 守卫）。
 */
import { Hono } from 'hono';
import { AccountsErrors } from '@tillgate/accounts';
import type { AccountUseCases } from '@tillgate/accounts';
import {
  Decimal,
  normalizeAmount,
  OUTSIDE_ACCOUNT,
  type OperationRun,
  type WalletApi,
} from '@tillgate/billing';
import { operationId } from '@tillgate/http';
import type { Observability } from '@tillgate/observability';
import type { SessionEnv } from '../middleware/session';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { usersContracts } from '../contracts/users';
import { toTransactionWireRow } from '../presenters/users';
import { toAuditWireRow } from '../presenters/observability';

/** billing operations 用例结构面（run 自开事务;execute 收 WalletTx） */
export type OperationsUseCase = {
  run<T extends Record<string, unknown>>(
    input: OperationRun<T>,
  ): Promise<{ receipt: T; replayed: boolean }>;
};

/** 同事务审计原语（装配闭包——observability/composition 的 writeAudit 经 assembly 注入） */
export type WriteAuditInTx = (
  tx: Parameters<OperationRun<Record<string, unknown>>['execute']>[0],
  entry: {
    actor: 'admin';
    adminId: number;
    action: string;
    targetType: string;
    targetId: string;
    detail: Record<string, unknown>;
  },
) => Promise<void>;

export interface UsersFundsRoutesDeps {
  readonly accounts: Pick<AccountUseCases, 'userExists'>;
  readonly wallet: Pick<WalletApi, 'credit' | 'transfer' | 'statement'>;
  readonly operations: OperationsUseCase;
  readonly writeAudit: WriteAuditInTx;
  readonly audit: Pick<Observability['audit'], 'listByTarget'>;
}

/** v1 FundsReceipt wire 形状 */
interface FundsReceipt {
  ok: true;
  balanceBefore: string;
  balanceAfter: string;
  replayed: boolean;
}

export function usersFundsRoutes(deps: UsersFundsRoutesDeps) {
  const app = new Hono<SessionEnv>();

  async function assertUser(userId: number): Promise<void> {
    if (!(await deps.accounts.userExists(userId))) {
      throw AccountsErrors.business('user_not_found', { userId });
    }
  }

  app.post('/v1/users/:id/adjust', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = usersContracts.adjust.parse(await c.req.json());
    const opId = operationId(c);
    const remark =
      body.remark ?? `管理员调账 ${body.amount.startsWith('-') ? '' : '+'}${body.amount}`;
    await assertUser(id);
    const { receipt, replayed } = await deps.operations.run({
      operationId: opId,
      kind: 'admin.adjust',
      payload: { userId: id, amount: body.amount, adminId: c.get('adminId'), remark },
      execute: async (tx) => {
        let result: { balanceBefore: string; balanceAfter: string };
        if (body.amount.startsWith('-')) {
          const magnitude = body.amount.slice(1);
          const posted = await deps.wallet.transfer({
            from: { userId: id },
            to: { code: OUTSIDE_ACCOUNT },
            amount: magnitude,
            refType: 'admin',
            refId: opId,
            ...(remark !== undefined ? { memo: remark } : {}),
            allowCredit: true,
            tx,
          });
          result = {
            balanceBefore: normalizeAmount(
              new Decimal(posted.fromBalanceAfter).plus(magnitude).toString(),
            ),
            balanceAfter: normalizeAmount(posted.fromBalanceAfter),
          };
        } else {
          const posted = await deps.wallet.credit({
            userId: id,
            amount: body.amount,
            refType: 'admin',
            refId: opId,
            ...(remark !== undefined ? { memo: remark } : {}),
            tx,
          });
          result = {
            balanceBefore: normalizeAmount(
              new Decimal(posted.balanceAfter).minus(body.amount).toString(),
            ),
            balanceAfter: normalizeAmount(posted.balanceAfter),
          };
        }
        await deps.writeAudit(tx, {
          actor: 'admin',
          adminId: c.get('adminId'),
          action: 'admin.adjust',
          targetType: 'user',
          targetId: String(id),
          detail: { amount: body.amount, remark, operationId: opId, ...result },
        });
        return result;
      },
    });
    const funds: FundsReceipt = { ok: true, ...receipt, replayed };
    return c.json(funds);
  });

  app.post('/v1/users/:id/gift', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = usersContracts.gift.parse(await c.req.json());
    const opId = operationId(c);
    const remark = body.remark ?? '管理员赠送';
    await assertUser(id);
    const { receipt, replayed } = await deps.operations.run({
      operationId: opId,
      kind: 'admin.gift',
      payload: { userId: id, amount: body.amount, adminId: c.get('adminId'), remark },
      execute: async (tx) => {
        const posted = await deps.wallet.credit({
          userId: id,
          amount: body.amount,
          refType: 'admin',
          refId: opId,
          memo: remark,
          tx,
        });
        const result = {
          balanceBefore: normalizeAmount(
            new Decimal(posted.balanceAfter).minus(body.amount).toString(),
          ),
          balanceAfter: normalizeAmount(posted.balanceAfter),
        };
        await deps.writeAudit(tx, {
          actor: 'admin',
          adminId: c.get('adminId'),
          action: 'admin.gift',
          targetType: 'user',
          targetId: String(id),
          detail: { amount: body.amount, remark, operationId: opId, ...result },
        });
        return result;
      },
    });
    const funds: FundsReceipt = { ok: true, ...receipt, replayed };
    return c.json(funds);
  });

  app.get('/v1/users/:id/transactions', async (c) => {
    const id = idParam(c.req.param('id'));
    // from/to 校验但忽略（日期过滤未启用;非法日期仍 400——v1 语义）
    usersContracts.transactionsQuery.parse(c.req.query());
    const query = parseListQuery(c.req.query(), ['id'], 'id');
    const items = await deps.wallet.statement({ userId: id, limit: query.limit });
    const rows = items.map((item) => toTransactionWireRow(id, item));
    // D4(MIGRATION §4):statement 无计数动词,total = offset + rows.length（末页精确）
    return c.json(listEnvelope(rows, query.offset + rows.length, query));
  });

  app.get('/v1/users/:id/audit-logs', async (c) => {
    const id = idParam(c.req.param('id'));
    const query = parseListQuery(c.req.query(), ['id', 'action', 'createdAt'], 'createdAt');
    const rows = await deps.audit.listByTarget({
      targetType: 'user',
      targetId: String(id),
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(rows.map(toAuditWireRow), query.offset + rows.length, query));
  });

  return app;
}
