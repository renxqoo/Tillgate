/**
 * 渠道运营资金服务：进货 / 调账（幂等：operations 用例——同键同参重放回执、
 * 异参 409）+ 流水列表。
 * 余额口径：upstream_budget；进货自动复活熔断渠道（status 3→0）；
 * 调账守卫 = 调后不得为负（0 行 → insufficient_budget 422）。
 * 凭证：data URL 解析 → 本地存储换键；凭证字节不进指纹（重放不重传凭证）。
 */
import { createOperationsUseCase } from '@ai-gateway/service';
import type { RunContext } from '@ai-gateway/service';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import { recordAudit } from '@ai-gateway/http';
import { AppError } from '../http/error-map.js';
import { parseVoucherDataUrl, type VoucherStorage } from './voucher-storage.js';
import type { ListQueryParts } from '../http/list-query.js';

export const CHANNEL_FUNDS_SORTS = ['id', 'amount', 'createdAt'] as const;

export interface ChannelFundsServiceDeps {
  db: Db;
  repos?: Repositories;
  voucherStorage: VoucherStorage;
  voucherMaxBytes: number;
}

export interface ChannelFundsService {
  recharge(
    ctx: RunContext,
    input: {
      adminId: number;
      channelId: number;
      amount: string;
      orderNo?: string | null;
      voucherDataUrl?: string | null;
      remark?: string | null;
      operationId: string;
    },
  ): Promise<{ ok: true; rechargeId: number; balanceAfter: string; replayed: boolean }>;
  adjust(
    ctx: RunContext,
    input: { adminId: number; channelId: number; amount: string; remark?: string | null; operationId: string },
  ): Promise<{ ok: true; rechargeId: number; balanceAfter: string; replayed: boolean }>;
  list(
    ctx: RunContext,
    input: { query: ListQueryParts; channelId?: number; type?: 'recharge' | 'adjust' },
  ): Promise<{
    rows: Array<{
      id: number;
      channelId: number;
      channelName: string;
      type: string;
      amount: string;
      balanceAfter: string;
      orderNo: string | null;
      voucher: string | null;
      remark: string | null;
      adminId: number | null;
      adminEmail: string | null;
      adminDisplayName: string | null;
      createdAt: Date;
    }>;
    total: number;
    page: number;
    pageSize: number;
  }>;
}

export function createChannelFundsService(deps: ChannelFundsServiceDeps): ChannelFundsService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();
  const operations = createOperationsUseCase({ db, repos });

  return {
    async recharge(ctx, input) {
      // 凭证先行落存储（事务外——字节不进指纹，重放不重传）
      let voucherKey: string | null = null;
      if (input.voucherDataUrl) {
        const parsed = parseVoucherDataUrl(input.voucherDataUrl, deps.voucherMaxBytes);
        voucherKey = await deps.voucherStorage.save(parsed.data, parsed.mimeType);
      }
      const orderNo = input.orderNo?.trim() || null;
      const remark = input.remark?.trim() || null;

      const { receipt, replayed } = await operations.run(ctx, {
        operationId: input.operationId,
        kind: 'channel.recharge',
        payload: {
          kind: 'channel.recharge',
          channelId: input.channelId,
          amount: input.amount,
          orderNo,
          remark,
          adminId: input.adminId,
          hasVoucher: voucherKey != null,
        },
        execute: async (tx) => {
          const c = { db: tx, ...ctx };
          const channel = await repos.channel.findChannel(c, input.channelId);
          if (!channel) throw new AppError(404, 'channel_not_found', 'Channel not found');
          // 进货：budget += amount；熔断(3)自动复活为启用(0)；返回新余额快照
          const balanceAfter = await repos.channel.rechargeBudget(c, {
            channelId: input.channelId,
            amount: input.amount,
            now: new Date(),
          });
          const rechargeId = await repos.channel.insertRecharge(c, {
            channelId: input.channelId,
            type: 'recharge',
            amount: input.amount,
            balanceAfter,
            orderNo,
            voucher: voucherKey,
            remark,
            adminId: input.adminId,
          });
          return { rechargeId, balanceAfter };
        },
      });
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'channel.recharge',
        targetType: 'channel',
        targetId: input.channelId,
        detail: { amount: input.amount, orderNo, hasVoucher: voucherKey != null, remark },
      });
      return { ok: true, ...receipt, replayed };
    },

    async adjust(ctx, input) {
      const remark = input.remark?.trim() || null;
      const { receipt, replayed } = await operations.run(ctx, {
        operationId: input.operationId,
        kind: 'channel.adjust',
        payload: {
          kind: 'channel.adjust',
          channelId: input.channelId,
          amount: input.amount,
          remark,
          adminId: input.adminId,
        },
        execute: async (tx) => {
          const c = { db: tx, ...ctx };
          const outcome = await repos.channel.tryAdjustBudget(c, {
            channelId: input.channelId,
            amount: input.amount,
            now: new Date(),
          });
          if (!outcome.ok) {
            // 0 行二义：渠道不存在 vs 守卫未过（调后为负）
            const channel = await repos.channel.findChannel(c, input.channelId);
            if (!channel) throw new AppError(404, 'channel_not_found', 'Channel not found');
            throw new AppError(422, 'insufficient_budget', 'Adjustment amount exceeds current purchase quota and cannot be deducted');
          }
          const rechargeId = await repos.channel.insertRecharge(c, {
            channelId: input.channelId,
            type: 'adjust',
            amount: input.amount,
            balanceAfter: outcome.budget,
            orderNo: null,
            voucher: null,
            remark,
            adminId: input.adminId,
          });
          return { rechargeId, balanceAfter: outcome.budget };
        },
      });
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'channel.adjust',
        targetType: 'channel',
        targetId: input.channelId,
        detail: { amount: input.amount, remark },
      });
      return { ok: true, ...receipt, replayed };
    },

    async list(ctx, input) {
      const result = await repos.channel.listRecharges({ db, ...ctx }, {
        q: input.query.q,
        channelId: input.channelId,
        type: input.type,
        sortBy: input.query.sortBy as (typeof CHANNEL_FUNDS_SORTS)[number],
        order: input.query.order,
        limit: input.query.limit,
        offset: input.query.offset,
      });
      return {
        rows: result.rows,
        total: result.total,
        page: input.query.page,
        pageSize: input.query.pageSize,
      };
    },
  };
}
