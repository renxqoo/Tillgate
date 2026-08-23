/**
 * 生成任务轮询 job（驱动壳）：状态机推进/信号顺序不变量在 inference 的
 * generation-poll 用例（application 层），本文件只提供节奏入口（DESIGN §1）。
 */
import type { GenerationPollResult } from '@tokenlens/inference';

type PollJob = () => Promise<GenerationPollResult>;

export function createPollJob(deps: { poll: () => Promise<GenerationPollResult> }): PollJob {
  return async function runPoll() {
    return await deps.poll();
  };
}
