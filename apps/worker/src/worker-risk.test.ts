import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TDD 红灯：worker 消费端应配置重试 / DLQ 兜底。
 *
 * 定位：apps/worker/src/index.ts:40
 *   new Worker('meter', fn, { connection, concurrency: env.WORKER_CONCURRENCY })
 *
 * 期望（安全行为）：
 *   计量是资损关键路径，job 失败不能静默丢失。应满足下列任一兜底：
 *     (a) Worker 配 defaultJobOptions / settings（含 attempts + backoff + removeOnFail），或
 *     (b) failed 事件转发到死信队列（DLQ）做二次处理，或
 *     (c) 至少有第二个 DLQ / 重放 Worker 消费者。
 *
 * 当前实现：Worker 只有 {connection, concurrency}，failed 只 logger.error，无 DLQ。
 * 虽然生产者侧 meter.ts:81 注入 attempts:3，但 3 次耗尽后 job 进 failed 永久留存，
 * 没有任何自动重放路径 → 计费事件可能永久丢失。
 * 以下断言全部报红 = 风险确认存在。
 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const INDEX_SRC = readFileSync(resolve(SRC_DIR, 'index.ts'), 'utf8');
const METER_SRC = readFileSync(resolve(SRC_DIR, '../../gateway/src/lib/meter.ts'), 'utf8');

describe('worker 消费端应有重试 / DLQ 兜底（红灯 = 风险确认）', () => {
  it('Worker 选项应含 attempts / backoff / defaultJobOptions / settings（当前全无 → 红）', () => {
    const workerBlock = INDEX_SRC.match(/new Worker<MeterJobData>\([\s\S]*?\{[\s\S]*?\}\s*\)/)?.[0] ?? '';
    expect(workerBlock.length, '应找到 new Worker 构造').toBeGreaterThan(0);
    // 期望至少出现其中一个兜底配置项
    const hasRetryConfig =
      /attempts\s*:/.test(workerBlock) ||
      /backoff\s*:/.test(workerBlock) ||
      /defaultJobOptions\s*:/.test(workerBlock) ||
      /settings\s*:/.test(workerBlock);
    expect(hasRetryConfig, 'Worker 消费端应配置重试/兜底参数').toBe(true);
  });

  it('failed 事件应转发到死信队列或告警（当前只 logger.error → 红）', () => {
    const failedHandler = INDEX_SRC.match(/meterWorker\.on\(\s*['"]failed['"][\s\S]*?\}\s*\)/)?.[0] ?? '';
    expect(failedHandler.length).toBeGreaterThan(0);
    // 期望 failed 处理含 DLQ 重投递 或 告警转发，而非纯日志
    expect(failedHandler, 'failed 事件应转发 DLQ/告警，不能只记日志').toMatch(/dlq|dead.?letter|requeue|\.add\(|alert|notify/i);
  });

  it('进程内应存在 DLQ / 重放 Worker（当前只有单个 meter Worker → 红）', () => {
    const workerCtorCount = (INDEX_SRC.match(/new Worker</g) ?? []).length;
    // 期望：要么有 DLQ worker（计数 >= 2），要么显式声明无 DLQ 的等价兜底
    expect(workerCtorCount, '应有 DLQ/重放 Worker 兜底失败 job').toBeGreaterThanOrEqual(2);
  });
});

describe('生产者侧重试配置自检（佐证：worker 端零配置会让重试耗尽后无救）', () => {
  it('MeterProducer 入队 attempts=3 + removeOnFail=true（3 次耗尽后无自动重放）', () => {
    // 这是事实陈述（绿），证明重试上限确实存在，耗尽后落到 worker 的 failed 事件
    expect(METER_SRC).toMatch(/attempts:\s*3/);
    expect(METER_SRC).toMatch(/removeOnFail:\s*true/);
  });
});
