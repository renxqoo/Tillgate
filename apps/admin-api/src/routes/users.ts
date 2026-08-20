/**
 * 用户路由（会话）：列表（钱包富化 + 企业过滤）/ 资料 / 补丁（封禁语义）/
 * 重置密码 / 调账 / 赠送 / 流水 / 用户审计。
 * 响应体永不包含 passwordHash（服务列白名单 + 测试红线锁定）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { operationId } from '@ai-gateway/http';
import { adminCtxOf } from './ctx.js';
import { parseListQuery } from '../http/list-query.js';
import { AppError } from '../http/error-map.js';
import { USER_SORTS, USER_AUDIT_SORTS, type UsersService } from '../services/users.service.js';
import type { FundsService } from '../services/funds.service.js';
import type { SessionEnv } from '../middleware/session.js';
import { nonNegativeMoneyString, positiveMoneyString, signedNonZeroMoneyString } from '../http/money-schema.js';

const idParam = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw new AppError(400, 'invalid_param', '路径参数 id 必须为正整数');
  }
  return id;
};

const enterpriseSchema = z.enum(['0', '1']).optional();

const listQueryExtra = z.object({
  status: z.coerce.number().int().min(0).max(2).optional(),
  enterprise: enterpriseSchema,
});

const patchSchema = z
  .object({
    status: z.number().int().min(0).max(2).optional(),
    rateCardId: z.number().int().positive().nullable().optional(),
    rpmLimit: z.number().int().min(1).nullable().optional(),
    tpmLimit: z.number().int().min(1).nullable().optional(),
    dailySpendLimit: nonNegativeMoneyString.nullable().optional(),
    displayName: z.string().max(64).nullable().optional(),
    email: z.string().email().max(255).nullable().optional(),
    isEnterprise: z.boolean().optional(),
    freezeReason: z.string().max(128).nullable().optional(),
    creditLimit: nonNegativeMoneyString.optional(),
  })
  .superRefine((value, ctx) => {
    // freezeReason 只能随封禁一并设置（状态语义不二义）
    if (value.freezeReason != null && value.status !== 1) {
      ctx.addIssue({ code: 'custom', message: 'freezeReason 只能在封禁（status=1）时一并设置' });
    }
  });

const setPasswordSchema = z.object({ password: z.string().min(8).max(128) });

const adjustSchema = z.object({
  amount: signedNonZeroMoneyString,
  remark: z.string().max(255).optional(),
});

const giftSchema = z.object({
  amount: positiveMoneyString,
  remark: z.string().max(255).optional(),
});

/** from/to 校验但忽略（v1 语义：日期过滤已退役，非法日期仍 400） */
const transactionsSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export function usersRoutes(
  service: UsersService,
  funds: FundsService,
  session: MiddlewareHandler<SessionEnv>,
) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/users', session, async (c) => {
    const extra = listQueryExtra.parse(c.req.query());
    const query = parseListQuery(c.req.query(), USER_SORTS, 'createdAt');
    return c.json(await service.list(adminCtxOf(c), { query, ...extra }));
  });

  app.get('/v1/users/:id', session, async (c) => {
    const profile = await service.profile(adminCtxOf(c), idParam(c.req.param('id')));
    return c.json(profile);
  });

  app.patch('/v1/users/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = patchSchema.parse(await c.req.json());
    const { creditLimit, dailySpendLimit, ...rest } = body;
    return c.json(
      await service.patch(adminCtxOf(c), {
        adminId: c.get('adminId'),
        userId: id,
        patch: {
          ...rest,
          ...(dailySpendLimit !== undefined ? { dailySpendLimit } : {}),
          ...(creditLimit !== undefined ? { creditLimit } : {}),
        },
      }),
    );
  });

  app.post('/v1/users/:id/set-password', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = setPasswordSchema.parse(await c.req.json());
    return c.json(
      await service.setPassword(adminCtxOf(c), { adminId: c.get('adminId'), userId: id, password: body.password }),
    );
  });

  app.post('/v1/users/:id/adjust', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = adjustSchema.parse(await c.req.json());
    const result = await funds.adjust(adminCtxOf(c), {
      adminId: c.get('adminId'),
      userId: id,
      amount: body.amount,
      remark: body.remark ?? `管理员调账 ${body.amount.startsWith('-') ? '' : '+'}${body.amount}`,
      operationId: operationId(c),
    });
    return c.json(result);
  });

  app.post('/v1/users/:id/gift', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = giftSchema.parse(await c.req.json());
    const result = await funds.gift(adminCtxOf(c), {
      adminId: c.get('adminId'),
      userId: id,
      amount: body.amount,
      remark: body.remark,
      operationId: operationId(c),
    });
    return c.json(result);
  });

  app.get('/v1/users/:id/transactions', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const extra = transactionsSchema.parse(c.req.query());
    void extra;
    // 有效上限 = page_size（1..100 钳制）；wallet statement newest-first
    const query = parseListQuery(c.req.query(), ['id'], 'id');
    const { rows, total } = await service.transactions(adminCtxOf(c), { userId: id, limit: query.limit });
    // v2 信封：前端 fetchAdminList 只读 data.rows/data.total（items 会让列表恒空）
    return c.json({ rows, total, page: query.page, pageSize: query.pageSize });
  });

  app.get('/v1/users/:id/audit-logs', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const query = parseListQuery(c.req.query(), USER_AUDIT_SORTS, 'createdAt');
    return c.json(await service.auditLogs(adminCtxOf(c), { userId: id, query }));
  });

  return app;
}
