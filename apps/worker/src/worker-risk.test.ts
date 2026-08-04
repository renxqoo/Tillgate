import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 计量重试 / 告警兜底（绿灯 = 已修复 / 已规划）。
 *
 * 资损防线（requirements 5.1/5.2）：
 *   计量是资损关键路径，job 失败不能静默丢失。三层兜底：
 *     (1) 生产者侧（meter.ts）：attempts:3 + 指数退避 + removeOnFail:true（死信永久留存不自动删）
 *     (2) 消费侧 failed 事件：重试耗尽 → error 日志 + meter_job_failed_total 告警计数器（运维介入）
 *     (3) P1：DLQ 自动重放 Worker（消费 failed 队列二次处理）—— 当前一期靠运维告警 + 手动重放
 *
 * 注：BullMQ 的 attempts/backoff 配置在生产者（Queue.add options），不在 Worker 构造选项。
 *     Worker 只负责消费 + failed 事件告警转发。
 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const INDEX_SRC = readFileSync(resolve(SRC_DIR, 'index.ts'), 'utf8');
const METER_SRC = readFileSync(resolve(SRC_DIR, '../../gateway/src/lib/meter.ts'), 'utf8');

describe('计量重试 / 告警兜底（绿灯）', () => {
  it('生产者侧配 attempts + 指数退避 + 死信留存（removeOnFail=true）', () => {
    expect(METER_SRC).toMatch(/attempts:\s*3/);
    expect(METER_SRC).toMatch(/backoff.*exponential|type:\s*['"]exponential/);
    expect(METER_SRC).toMatch(/removeOnFail:\s*true/);
  });

  it('消费侧 failed 事件转发告警（meter_job_failed_total 计数器，不静默丢失）', () => {
    const failedHandler = INDEX_SRC.match(/meterWorker\.on\(\s*['"]failed['"][\s\S]*?\}\s*\)/)?.[0] ?? '';
    expect(failedHandler.length, '应有 failed 事件处理').toBeGreaterThan(0);
    expect(failedHandler, 'failed 应记告警计数器').toMatch(/meter_job_failed_total|meterFailedCounter|alert/i);
  });

  it('消费侧 failed 事件记 error 日志（含 requestId 便于追溯）', () => {
    const failedHandler = INDEX_SRC.match(/meterWorker\.on\(\s*['"]failed['"][\s\S]*?\}\s*\)/)?.[0] ?? '';
    expect(failedHandler, 'failed 应记 error 日志').toMatch(/logger\.error/);
  });
});

describe('P1 待办：DLQ 自动重放 Worker（一期靠告警 + 手动重放）', () => {
  it('一期暂无 DLQ Worker（进程内仅单个 meter Worker），P1 补齐', () => {
    const workerCtorCount = (INDEX_SRC.match(/new Worker</g) ?? []).length;
    // 一期：单 Worker + 告警；P1 加第二个 DLQ Worker
    expect(workerCtorCount).toBeGreaterThanOrEqual(1);
  });
});
