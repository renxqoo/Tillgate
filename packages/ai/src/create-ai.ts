import type {
  ChannelDesc,
  ChatResult,
  ChatStreamResult,
  ProbeResult,
  RequestCtx,
} from './types.js';
import type { AiConfig, AiDeps } from './config.js';
import { defaultAiConfig } from './config.js';

export interface Ai {
  /** 非流式（自动 withRetry：可重试错误 + 空完成重试） */
  chat(input: { channel: ChannelDesc; request: unknown; ctx: RequestCtx }): Promise<ChatResult>;
  /** 流式（透传管道；重试仅限首字节前，流开始后失败发错误帧不重试） */
  chatStream(input: {
    channel: ChannelDesc;
    request: unknown;
    ctx: RequestCtx;
  }): Promise<ChatStreamResult>;
  /** 连通性探测（admin-api 渠道测试用） */
  probe(channel: ChannelDesc): Promise<ProbeResult>;
}

// TODO(ai): 组装：适配器注册表（protocol→adapter）+ withRetry + breaker 绑定 + 事件输出
export function createAi(config?: AiConfig, _deps?: AiDeps): Ai {
  const cfg = config ?? defaultAiConfig();
  void cfg;

  return {
    async chat() {
      throw new Error('not implemented: packages/ai 纯逻辑实现为下一阶段任务');
    },
    async chatStream() {
      throw new Error('not implemented: packages/ai 纯逻辑实现为下一阶段任务');
    },
    async probe() {
      throw new Error('not implemented: packages/ai 纯逻辑实现为下一阶段任务');
    },
  };
}
