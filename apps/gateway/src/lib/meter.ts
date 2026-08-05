import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * 计量事件数据（gateway 推入 BullMQ meter 队列，worker 消费结算）。
 * 包含 worker 结算所需的全部信息（gateway 知道但 worker 不知道的快照）。
 */
export interface MeterJobData {
  /** 幂等键（usage_logs.request_id 唯一约束，防重复结算） */
  requestId: string;
  userId: number;
  apiKeyId: number | null;
  appId: number | null;
  /** key / jwt */
  credentialType: string;
  /** 对外模型名（用户请求的） */
  externalModel: string;
  /** 实际模型名（上游真实模型，可能经 fallback 切换） */
  realModel: string;
  /** 最终成功的渠道 ID（候选循环选中的） */
  channelId: number | null;
  /** usage（ai 包归一化后的 token 数） */
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    estimated: boolean;
  };
  // ---- 价格快照（厘/百万 token，从 model_mappings 取） ----
  inputPrice: number;
  outputPrice: number;
  cacheInputPrice: number;
  /** 费率卡系数（数值，如 1.0） */
  coefficient: number;
  coefficientMilli: number;
  /** 请求耗时 ms */
  durationMs: number;
  /** 是否流式 */
  stream: boolean;
  /** 流式是否中断（terminated） */
  streamAborted: boolean;
  /** 预扣金额（厘），worker 结算时对账用（hold 期间余额被占，结算后对账补扣/退款） */
  holdAmount: number;
  /** 模型映射 ID（模型级 TPM 回填用） */
  mappingId: number;
}

export const METER_QUEUE_NAME = 'meter';

/** 入队结果（调用方据此决定是否记日志/告警） */
export interface EnqueueResult {
  ok: boolean;
  error?: Error;
}

/** 入队失败回调签名（gateway 注入 logger + metrics） */
export type EnqueueFailureHandler = (data: MeterJobData, error: Error) => void;

/**
 * 计量生产者：gateway 侧把 ai 事件转成 job 推入 BullMQ 队列。
 *
 * 资损防线（B4）：
 *   - 失败不静默吞掉：返回 {ok:false, error}，调用方据此记日志 + 告警指标
 *   - removeOnFail=false：失败 job 永久保留（BullMQ 语义 false=count:-1=保留全部），
 *     供运维定期处理死信队列（重放 syncSettle）；true=count:0=删除全部（旧 bug，已修）
 *   - attempts 3 + 指数退避：短暂抖动自动恢复
 */
export class MeterProducer {
  private queue: Queue<MeterJobData>;
  /** 入队失败钩子（gateway 注入：记日志 + meter_enqueue_failed_total 指标） */
  onFailure: EnqueueFailureHandler | null = null;

  constructor(redis: Redis) {
    this.queue = new Queue<MeterJobData>(METER_QUEUE_NAME, { connection: redis });
  }

  async enqueue(data: MeterJobData): Promise<EnqueueResult> {
    try {
      // jobId = requestId → 幂等（同请求只入队一次，BullMQ 自动去重）
      await this.queue.add('meter', data, {
        jobId: data.requestId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        // removeOnFail=false：失败 job 永久保留（BullMQ false=count:-1），
        // 防死信被自动删导致永久漏计费。需运维定期处理死信队列（重放 syncSettle）。
        removeOnFail: false,
      });
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // 通知回调（不抛异常，不阻塞响应路径；调用方 fire-and-forget）
      this.onFailure?.(data, error);
      return { ok: false, error };
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
