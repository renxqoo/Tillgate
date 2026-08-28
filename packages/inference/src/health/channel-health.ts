import type { Ai, TerminationReason } from '@tillgate/ai';
import type { HealthStore } from '../ports/state';
import { createCircuitBreaker, type BreakerConfig, type CircuitBreakerHandle } from './breaker';
import {
  createDeadCredentialTracker,
  type DeadCredentialConfig,
  type DeadCredentialHandle,
} from './dead-credential';

/**
 * 渠道健康装配（零运维状态的 inference 侧实现）：以 AiEvent 订阅者身份维护
 * 熔断/死凭据跨请求状态（消费点在订阅面与候选循环）。
 *
 * 事件 → 状态映射：
 *   - failed → 熔断按 error.circuitTrip 计数、死凭据按 error.deadCredential 计数；
 *   - first_chunk → 流式「首字节即成功」记账；
 *     事件不带 channelKey，经 attempt_start 维护的 requestId→channelKey 映射取键；
 *   - success（终态）→ terminated ∈ 故障族（inactivity/upstream_*）计熔断失败
 *     （非客户端断开计入熔断），否则记成功；死凭据随成功自愈；
 *   - empty_completion → 不计（空完成走独立重试预算，非渠道健康信号），
 *     但作为请求终态参与 requestId→channelKey 映射清理（ai 非流式空完成重试
 *     耗尽只发 empty_completion，无 failed/success 跟随——不清理即映射泄漏）。
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
 * 同 host 多渠道共享状态。
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

/** 状态机缓存（渠道键 → 熔断器 / 死凭据追踪器）。机器级键前缀：熔断与死凭据状态形状不同，同键存同存储会互相踩踏——前缀隔离是结构约束，不依赖装配侧给不同 prefix。 */
function createHealthMachines(env: {
  store: HealthStore;
  config: { breaker: BreakerConfig; deadCredential: DeadCredentialConfig };
}) {
  const breakers = new Map<string, CircuitBreakerHandle>();
  const trackers = new Map<string, DeadCredentialHandle>();
  return {
    breakerOf(key: string): CircuitBreakerHandle {
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
    },
    trackerOf(key: string): DeadCredentialHandle {
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
    },
  };
}

/** fire-and-forget：状态机更新失败不外溢（尽力保护语义） */
type Fire = (work: Promise<void>, context: string) => void;

/** 事件记账上下文（状态机缓存 + 渠道映射 + fire-and-forget 面） */
interface HealthEventCtx {
  machines: ReturnType<typeof createHealthMachines>;
  currentChannel: Map<string, string>;
  fire: Fire;
}

/** 成功记账：熔断恢复 + 死凭据自愈（双状态机共用） */
function recordHealthSuccess(ctx: HealthEventCtx, key: string): void {
  ctx.fire(ctx.machines.breakerOf(key).recordSuccess(), `breaker recordSuccess key=${key}`);
  ctx.fire(ctx.machines.trackerOf(key).recordSuccess(), `credential recordSuccess key=${key}`);
}

/** failed 事件：熔断按 circuitTrip 计数、死凭据按 deadCredential 计数 */
function onFailedEvent(
  ctx: HealthEventCtx,
  e: {
    requestId: string;
    channelKey: string;
    error: { circuitTrip: boolean; deadCredential: boolean };
  },
): void {
  ctx.currentChannel.delete(e.requestId);
  ctx.fire(
    ctx.machines.breakerOf(e.channelKey).recordFailure({ circuitTrip: e.error.circuitTrip }),
    `breaker recordFailure key=${e.channelKey}`,
  );
  ctx.fire(
    ctx.machines.trackerOf(e.channelKey).recordFailure({ deadCredential: e.error.deadCredential }),
    `credential recordFailure key=${e.channelKey}`,
  );
}

/** success 事件：terminated ∈ 故障族计熔断失败（非客户端断开计入熔断），否则记成功 */
function onSuccessEvent(
  ctx: HealthEventCtx,
  e: { requestId: string; channelKey: string; terminated?: TerminationReason },
): void {
  ctx.currentChannel.delete(e.requestId);
  if (e.terminated !== undefined && TRIP_TERMINATIONS.has(e.terminated)) {
    ctx.fire(
      ctx.machines.breakerOf(e.channelKey).recordFailure({ circuitTrip: true }),
      `breaker recordFailure(terminated=${e.terminated}) key=${e.channelKey}`,
    );
    return;
  }
  recordHealthSuccess(ctx, e.channelKey);
}

/** ai 事件 → 健康状态机记账（事件映射语义见文件头注记） */
function onHealthEvent(
  ctx: HealthEventCtx,
  e: Parameters<Parameters<Ai['subscribe']>[0]>[0],
): void {
  switch (e.type) {
    case 'attempt_start': {
      ctx.currentChannel.set(e.requestId, e.channelKey);
      break;
    }
    case 'failed': {
      onFailedEvent(ctx, e);
      break;
    }
    case 'first_chunk': {
      // 流式首字节即成功；键取本请求最近一次 attempt_start 的渠道
      const key = ctx.currentChannel.get(e.requestId);
      if (key != null) recordHealthSuccess(ctx, key);
      break;
    }
    case 'empty_completion': {
      // 请求终态（ai 非流式空完成重试耗尽只发本事件，无 failed/success 跟随）：
      // 不进健康状态机，但必须清理映射——否则 currentChannel 随请求量无界增长
      ctx.currentChannel.delete(e.requestId);
      break;
    }
    case 'success': {
      onSuccessEvent(ctx, e);
      break;
    }
    default: {
      break;
    } // param_adjustment/stream_error/aborted/usage 非终态不进健康状态机，也不清映射
  }
}

export function createChannelHealth(env: {
  store: HealthStore;
  config: { breaker: BreakerConfig; deadCredential: DeadCredentialConfig };
  onFault?: (error: unknown, context: string) => void;
}): ChannelHealth {
  const note =
    env.onFault ??
    ((error: unknown, context: string) => console.error(`[inference.health] ${context}:`, error));
  const machines = createHealthMachines(env);
  /** requestId → channelKey（attempt_start 维护；first_chunk 无渠道键，借映射记账） */
  const currentChannel = new Map<string, string>();
  const fire: Fire = (work, context) => {
    void work.catch((error) => note(error, context));
  };
  const eventCtx: HealthEventCtx = { machines, currentChannel, fire };
  const onEvent = (e: Parameters<Parameters<Ai['subscribe']>[0]>[0]): void =>
    onHealthEvent(eventCtx, e);

  return {
    attach(ai: Ai): () => void {
      return ai.subscribe(onEvent);
    },
    async admit(channelKey: string): Promise<HealthAdmission> {
      try {
        if (!(await machines.breakerOf(channelKey).canRequest())) {
          return { ok: false, reason: 'circuit_open' };
        }
        if (!(await machines.trackerOf(channelKey).canRequest())) {
          return { ok: false, reason: 'dead_credential' };
        }
        return { ok: true };
      } catch (error) {
        // 存储故障 fail-open：健康检查不得成为可用性单点
        note(error, `admit key=${channelKey}`);
        return { ok: true };
      }
    },
  };
}
