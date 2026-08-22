import type { Ai, TerminationReason } from '@tokenlens/ai';
import type { HealthStore } from '../ports/state';
import { createCircuitBreaker, type BreakerConfig, type CircuitBreakerHandle } from './breaker';
import {
  createDeadCredentialTracker,
  type DeadCredentialConfig,
  type DeadCredentialHandle,
} from './dead-credential';

/**
 * 渠道健康装配（§3.6 零运维状态的 inference 侧实现）：以 AiEvent 订阅者身份维护
 * 熔断/死凭据跨请求状态（v1 在 ai 内注入存储 + 管线内记账；v2 消费点移到订阅面与
 * 候选循环，DESIGN C4）。
 *
 * 事件 → 状态映射（对齐 v1 记账语义）：
 *   - failed → 熔断按 error.circuitTrip 计数、死凭据按 error.deadCredential 计数；
 *   - first_chunk → 流式「首字节即成功」记账（v1 在 peek 成功后 fireAndForget）；
 *     事件不带 channelKey，经 attempt_start 维护的 requestId→channelKey 映射取键；
 *   - success（终态）→ terminated ∈ 故障族（inactivity/upstream_*）计熔断失败
 *     （v1 B6：非客户端断开计入熔断），否则记成功；死凭据随成功自愈；
 *   - empty_completion → 不计（空完成走独立重试预算，非渠道健康信号）。
 *
 * 回调契约：同步部分 O(1) 判型 + fire-and-forget（异步状态机更新不 await、异常吞掉
 * 经 onFault 观察）；存储故障 fail-open（admit 放行——健康是保护机制不是准入事实源）。
 */

/** 中断原因中的渠道故障族（计入熔断；client_disconnect/request_cancelled/server_draining 不计） */
const TRIP_TERMINATIONS: ReadonlySet<TerminationReason> = new Set([
  'inactivity',
  'upstream_error',
  'upstream_disconnected',
  'upstream_truncated',
]);

/**
 * 健康键（与 ai 事件 channelKey 同算法的单一真相）：protocol://host——
 * 同 host 多渠道共享状态（v1 B2 已知语义，保留）。
 */
export function channelHealthKey(channel: { protocol: string; baseUrl: string }): string {
  try {
    return `${channel.protocol}://${new URL(channel.baseUrl).host}`;
  } catch {
    return `${channel.protocol}://unknown`;
  }
}

export type HealthAdmission =
  | { ok: true }
  | { ok: false; reason: 'circuit_open' | 'dead_credential' };

export interface ChannelHealth {
  /** 订阅 ai 全局事件总线；返回退订函数（装配处挂一次） */
  attach(ai: Ai): () => void;
  /** 尝试前放行检查（候选循环每渠道一次；half-open 单探测赢家在此产生） */
  admit(channelKey: string): Promise<HealthAdmission>;
}

export function createChannelHealth(env: {
  store: HealthStore;
  config: { breaker: BreakerConfig; deadCredential: DeadCredentialConfig };
  onFault?: (error: unknown, context: string) => void;
}): ChannelHealth {
  const note =
    env.onFault ??
    ((error: unknown, context: string) => console.error(`[inference.health] ${context}:`, error));
  const breakers = new Map<string, CircuitBreakerHandle>();
  const trackers = new Map<string, DeadCredentialHandle>();
  /** requestId → channelKey（attempt_start 维护；first_chunk 无渠道键，借映射记账） */
  const currentChannel = new Map<string, string>();

  // 机器级键前缀（v1 双前缀语义）：熔断与死凭据状态形状不同，同键存同存储会互相
  // 踩踏——前缀隔离是结构约束，不依赖装配侧给不同 prefix。
  const breakerOf = (key: string): CircuitBreakerHandle => {
    let breaker = breakers.get(key);
    if (breaker == null) {
      breaker = createCircuitBreaker({
        key: `breaker:${key}`,
        config: env.config.breaker,
        store: env.store,
      });
      breakers.set(key, breaker);
    }
    return breaker;
  };
  const trackerOf = (key: string): DeadCredentialHandle => {
    let tracker = trackers.get(key);
    if (tracker == null) {
      tracker = createDeadCredentialTracker({
        key: `credential:${key}`,
        config: env.config.deadCredential,
        store: env.store,
      });
      trackers.set(key, tracker);
    }
    return tracker;
  };

  /** fire-and-forget：状态机更新失败不外溢（尽力保护语义） */
  const fire = (work: Promise<void>, context: string): void => {
    void work.catch((error) => note(error, context));
  };
  const recordSuccess = (key: string): void => {
    fire(breakerOf(key).recordSuccess(), `breaker recordSuccess key=${key}`);
    fire(trackerOf(key).recordSuccess(), `credential recordSuccess key=${key}`);
  };

  const onEvent = (e: Parameters<Parameters<Ai['subscribe']>[0]>[0]): void => {
    switch (e.type) {
      case 'attempt_start':
        currentChannel.set(e.requestId, e.channelKey);
        break;
      case 'failed': {
        currentChannel.delete(e.requestId);
        const { channelKey, error } = e;
        fire(
          breakerOf(channelKey).recordFailure({ circuitTrip: error.circuitTrip }),
          `breaker recordFailure key=${channelKey}`,
        );
        fire(
          trackerOf(channelKey).recordFailure({ deadCredential: error.deadCredential }),
          `credential recordFailure key=${channelKey}`,
        );
        break;
      }
      case 'first_chunk': {
        // 流式首字节即成功（v1 语义）；键取本请求最近一次 attempt_start 的渠道
        const key = currentChannel.get(e.requestId);
        if (key != null) recordSuccess(key);
        break;
      }
      case 'success': {
        currentChannel.delete(e.requestId);
        if (e.terminated !== undefined && TRIP_TERMINATIONS.has(e.terminated)) {
          fire(
            breakerOf(e.channelKey).recordFailure({ circuitTrip: true }),
            `breaker recordFailure(terminated=${e.terminated}) key=${e.channelKey}`,
          );
          break;
        }
        recordSuccess(e.channelKey);
        break;
      }
      default:
        break; // param_adjustment/stream_error/aborted/usage/empty_completion 不进健康状态机
    }
  };

  return {
    attach(ai: Ai): () => void {
      return ai.subscribe(onEvent);
    },
    async admit(channelKey: string): Promise<HealthAdmission> {
      try {
        if (!(await breakerOf(channelKey).canRequest()))
          return { ok: false, reason: 'circuit_open' };
        if (!(await trackerOf(channelKey).canRequest()))
          return { ok: false, reason: 'dead_credential' };
        return { ok: true };
      } catch (error) {
        // 存储故障 fail-open：健康检查不得成为可用性单点（v1 redis fail-open 同款）
        note(error, `admit key=${channelKey}`);
        return { ok: true };
      }
    },
  };
}
