/**
 * 用量读服务：明细（billedBy 拆分 + key/app 来源名）/ 按模型聚合 / 实时速率。
 * 用户隔离是硬条件（repo 层 userId 强绑定）；金额全程字符串。
 */
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories, type UsageRow } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';

export interface UsageRowModel {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cost: string;
}

export interface UsageService {
  list(
    ctx: RunContext,
    userId: number,
    input: { page: number; limit: number; from?: string; to?: string; model?: string },
  ): Promise<{ rows: UsageRow[]; total: number }>;
  byModel(
    ctx: RunContext,
    userId: number,
    input: { from?: string; to?: string },
  ): Promise<UsageRowModel[]>;
  rate(ctx: RunContext, userId: number): Promise<{ rpm: number; tpm: number }>;
}

const asUser = (ctx: RunContext, userId: number) => ({ ...ctx, actor: { kind: 'user' as const, id: userId } });

export function createUsageService(deps: { db: Db; repos?: Repositories }): UsageService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();

  return {
    async list(ctx, userId, input) {
      return repos.usageLog.listForUser({ db, ...asUser(ctx, userId) }, {
        userId,
        limit: input.limit,
        offset: (input.page - 1) * input.limit,
        from: input.from ? new Date(input.from) : undefined,
        to: input.to ? new Date(input.to) : undefined,
        model: input.model,
      });
    },
    async byModel(ctx, userId, input) {
      // 默认近 30 天（避免全表聚合）
      const from = input.from ? new Date(input.from) : new Date(Date.now() - 30 * 86_400_000);
      return repos.usageLog.aggregateByModel({ db, ...asUser(ctx, userId) }, {
        userId,
        from,
        to: input.to ? new Date(input.to) : undefined,
      });
    },
    rate(ctx, userId) {
      return repos.usageLog.rateLastMinute({ db, ...asUser(ctx, userId) }, userId);
    },
  };
}
