import type { HealthStore } from '../ports/state';
import type { RoutingPolicyReader } from '../ports/routing';
import { createModelDeadTracker, type ModelDeadHandle } from './model-dead';
import { createPenaltyTracker, type PenaltyHandle, type PenaltyKind } from './penalty';

/**
 * 路由记忆 port（渠道惩罚箱 + 模型死记忆的聚合装配面）：
 * 记账点在候选循环收口（dispatchFailure / settle / 候选耗尽），查询点在
 * 渠道门与候选门。参数全部来自 RoutingPolicyReader（热配置——管理台改动
 * TTL 内生效，不重启）；fail-open 语义（存储故障 = 无记忆，退化为 static
 * 路由，不反噬请求路径）。
 *
 * 键前缀：machine 级语义隔离（penalty/dead-model 形状不同）。
 */
export interface RoutingMemory {
  /** 渠道冷却期内 → true（条件门语义见 routing/gates.ts） */
  penalized(channelId: number): Promise<boolean>;
  /** 惩罚剩余毫秒（0 = 无惩罚/已过期）——终局有界等待的最早恢复依据 */
  penaltyRemainingMs(channelId: number): Promise<number>;
  /** 记一次渠道惩罚（fire-and-forget 面：调用方不 await） */
  recordPenalty(channelId: number, kind: PenaltyKind, retryAfterMs?: number): void;
  /** 候选判死窗口内 → true（候选门跳过） */
  deadModel(realModel: string): Promise<boolean>;
  /** 候选全渠道耗尽记一次（fire-and-forget） */
  recordModelFailure(realModel: string): void;
  /** 候选成功清零（fire-and-forget；无状态 no-op） */
  recordModelSuccess(realModel: string): void;
}

/** 惩罚记账的 fire-and-forget 面（异常吞掉经 onFault 观察——尽力记忆语义） */
type Fire = (work: Promise<void>, context: string) => void;

interface MemoryFaceEnv {
  store: HealthStore;
  policy: RoutingPolicyReader;
  fire: Fire;
  now: () => number;
}

/** 渠道惩罚面（查询 fail-open；记账 fire-and-forget） */
function penaltyFace(
  env: MemoryFaceEnv,
): Pick<RoutingMemory, 'penalized' | 'penaltyRemainingMs' | 'recordPenalty'> {
  const trackerOf = (channelId: number): PenaltyHandle =>
    createPenaltyTracker({
      key: `penalty:ch:${channelId}`,
      config: env.policy.latest().penalty,
      store: env.store,
      now: env.now,
    });
  return {
    async penalized(channelId) {
      try {
        return await trackerOf(channelId).penalized();
      } catch (error) {
        env.fire(Promise.reject(error), `penalized channel=${channelId}`); // 观察但不反噬
        return false; // fail-open：无记忆 = 不跳过
      }
    },
    async penaltyRemainingMs(channelId) {
      try {
        return await trackerOf(channelId).remainingMs();
      } catch {
        return 0; // fail-open：读不到 = 无等待依据
      }
    },
    recordPenalty(channelId, kind, retryAfterMs) {
      env.fire(
        trackerOf(channelId).record(kind, retryAfterMs),
        `recordPenalty channel=${channelId} kind=${kind}`,
      );
    },
  };
}

/** 模型死记忆面（查询 fail-open；记账 fire-and-forget） */
function modelFace(
  env: MemoryFaceEnv,
): Pick<RoutingMemory, 'deadModel' | 'recordModelFailure' | 'recordModelSuccess'> {
  const trackerOf = (realModel: string): ModelDeadHandle =>
    createModelDeadTracker({
      key: `dead-model:${realModel}`,
      config: env.policy.latest().modelDead,
      store: env.store,
      now: env.now,
    });
  return {
    async deadModel(realModel) {
      try {
        return await trackerOf(realModel).isDead();
      } catch (error) {
        env.fire(Promise.reject(error), `deadModel model=${realModel}`); // 观察但不反噬
        return false;
      }
    },
    recordModelFailure(realModel) {
      env.fire(trackerOf(realModel).recordFailure(), `recordModelFailure model=${realModel}`);
    },
    recordModelSuccess(realModel) {
      env.fire(trackerOf(realModel).recordSuccess(), `recordModelSuccess model=${realModel}`);
    },
  };
}

export function createRoutingMemory(env: {
  store: HealthStore;
  policy: RoutingPolicyReader;
  onFault?: (error: unknown, context: string) => void;
  now?: () => number;
}): RoutingMemory {
  const note =
    env.onFault ??
    ((error: unknown, context: string) => console.error(`[inference.routing] ${context}:`, error));
  const fire: Fire = (work, context) => {
    void work.catch((error) => note(error, context));
  };
  const faceEnv: MemoryFaceEnv = {
    store: env.store,
    policy: env.policy,
    fire,
    now: env.now ?? Date.now,
  };
  return {
    ...penaltyFace(faceEnv),
    ...modelFace(faceEnv),
  };
}
