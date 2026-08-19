import { Hono } from 'hono';
import { ACCOUNT_STATUS } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { MONEY_MAX, intParam, jsonBody, operationId, query, listQuerySchema } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import {
  getUserProfile, listUserAuditLogs, listUsers, listUserTransactions, setUserPassword,
  updateUser, userListQuerySchema, userTransactionsQuerySchema,
} from '../services/users.js';
import { mapMoneyError } from '../services/funds.js';

/**
 * 用户管理（api-contract §4.4）。
 *
 *   - GET  /：列表（搜索 q 走 subject/email/display_name 模糊 / 状态筛选 / 分页）
 *   - GET  /:id：详情
 *   - PATCH /:id：封禁/解封、绑定费率卡、调限流（规则见 services/users.updateUser）
 *   - POST /:id/set-password：管理员开通本地账号（初始密码 + 绑定默认费率卡）
 *   - POST /:id/adjust | /:id/gift：调账/赠送（ledger 事务 + 幂等键）
 *   - GET  /:id/transactions | /:id/audit-logs：管理员视角流水与审计
 */

const userUpdateSchema = z
  .object({
    /** 0 正常 / 1 封禁 / 2 注销 */
    status: z.number().int().min(0).max(2).optional(),
    rateCardId: z.number().int().positive().nullable().optional(),
    rpmLimit: z.number().int().min(1).nullable().optional(),
    tpmLimit: z.number().int().min(1).nullable().optional(),
    /** 透支上限（元，>=0）。信用模型：balance 允许降到 -credit_limit。 */
    creditLimit: z.number().min(0).max(MONEY_MAX).optional(),
    /** 每日花费上限（元，>=0）。NULL=不限。 */
    dailySpendLimit: z.number().min(0).max(MONEY_MAX).nullable().optional(),
    displayName: z.string().max(64).optional(),
    email: z.string().email().max(255).nullable().optional(),
    /** 是否企业用户（企业用户可购买团队套餐/席位） */
    isEnterprise: z.boolean().optional(),
    /** 封禁原因（写入 freeze_reason，便于审计/解冻判定）；必须与 status=1 同请求提供 */
    freezeReason: z.string().max(128).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.freezeReason !== undefined && v.status !== ACCOUNT_STATUS.BANNED) {
      ctx.addIssue({
        code: 'custom',
        path: ['freezeReason'],
        message: 'freezeReason 只能在封禁（status=1）时一并设置',
      });
    }
  });

const setPasswordSchema = z.object({
  password: z.string().min(8).max(128),
});

/** 资金操作金额上限（元）：numeric(38,18) 安全范围内的人为业务上限 */
/** 资金操作金额上限（元）：numeric(38,18) 安全范围内的人为业务上限（全管理端统一口径） */

const userAdjustSchema = z.object({
  /** 调账金额（元，小数），正=增加，负=扣减 */
  amount: z.coerce
    .number()
    .finite()
    .refine((v) => v !== 0, '调账金额不能为 0')
    .refine((v) => Math.abs(v) <= MONEY_MAX, `调账金额绝对值不得超过 ${MONEY_MAX} 元`),
  remark: z.string().max(255).optional(),
});

const userGiftSchema = z.object({
  amount: z.coerce
    .number()
    .positive()
    .finite()
    .max(MONEY_MAX, `赠送金额不得超过 ${MONEY_MAX} 元`),
  remark: z.string().max(255).optional(),
});

export function userAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // 列表（搜索 + 状态筛选 + 分页）
    .get('/', query(userListQuerySchema), async (c) =>
      c.json(await listUsers(s, c.req.valid('query'))),
    )

    // 详情
    .get('/:id', async (c) => c.json(await getUserProfile(s, intParam(c, 'id'))))

    // PATCH：封禁/解封/绑卡/限流/资料
    .patch('/:id', jsonBody(userUpdateSchema), async (c) => {
      const id = intParam(c, 'id');
      const updated = await updateUser(s, id, c.req.valid('json'), c.get('adminId'));
      return c.json(updated);
    })

    // 管理员开通本地账号（设置初始密码 + 绑定默认费率卡）
    .post('/:id/set-password', jsonBody(setPasswordSchema), async (c) => {
      const id = intParam(c, 'id');
      await setUserPassword(s, id, c.req.valid('json').password, c.get('adminId'));
      return c.json({ ok: true });
    })

    // 手动调账（正负皆可，扣减受信用地板守卫——wallet transfer allowCredit）
    .post('/:id/adjust', jsonBody(userAdjustSchema), async (c) => {
      const id = intParam(c, 'id');
      const body = c.req.valid('json');
      try {
        const result = await s.funds.adjust({
          operationId: operationId(c),
          userId: id,
          amount: String(body.amount),
          adminId: c.get('adminId'),
          remark: body.remark ?? `管理员调账 ${body.amount > 0 ? '+' : ''}${body.amount}`,
        });
        return c.json({ ok: true, balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter });
      } catch (error) {
        throw mapMoneyError(error);
      }
    })

    // 手动赠送（wallet.credit，counter-leg = outside 镜像）
    .post('/:id/gift', jsonBody(userGiftSchema), async (c) => {
      const id = intParam(c, 'id');
      const body = c.req.valid('json');
      try {
        const result = await s.funds.gift({
          operationId: operationId(c),
          userId: id,
          amount: String(body.amount),
          adminId: c.get('adminId'),
          remark: body.remark ?? '管理员赠送',
        });
        return c.json({ ok: true, balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter });
      } catch (error) {
        throw mapMoneyError(error);
      }
    })

    // 用户资金流水（管理员视角）
    .get(
      '/:id/transactions',
      query(userTransactionsQuerySchema),
      async (c) => c.json(await listUserTransactions(s, intParam(c, 'id'), c.req.valid('query'))),
    )

    // 用户审计日志（管理员视角，target_type=user）
    .get('/:id/audit-logs', query(listQuerySchema), async (c) =>
      c.json(await listUserAuditLogs(s, intParam(c, 'id'), c.req.valid('query'))),
    );
}
