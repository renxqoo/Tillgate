/**
 * 渠道解析（app 编排）：realModel → 调度序候选渠道。
 * repo 给基序（priority/weight 降序）；本层施加调度规则（分层 + 层内加权随机）。
 * Redis 缓存 / apiKey 解密 / 死凭据落库（status=4 + 事件箱）是 G4 管线加固项——老网关参照。
 */
import { createRepositories, type Db, type Repositories, type RouteCandidateRow } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { readOnly } from '@ai-gateway/service';
import { weightedOrderByPriority } from './schedule.js';

export function createResolveChannels(deps: { db: Db; repos?: Repositories; rng?: () => number }) {
  const repos = deps.repos ?? createRepositories();
  return async function resolveChannels(
    ctx: RunContext,
    realModel: string,
  ): Promise<RouteCandidateRow[]> {
    const rows = await repos.channel.findRouteCandidates(readOnly(ctx, deps.db), realModel);
    return weightedOrderByPriority(rows, deps.rng);
  };
}
