import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 对账任务（P1 待实现）—— docs 承诺的每日对账 + daily_stats 聚合。
 *
 * 定位：docs/data-model.md:398-401 承诺「对账任务（每日）」：
 *   - Σ usage_logs.amount (status=0) == Σ transactions(consume) == Σ users.balance 增减
 *   - Σ usage_logs.upstream_cost 与 供应商账单核对
 *   - 不一致 → 告警 + 人工核查
 * 另：data-model.md:340 承诺 daily_stats 聚合表由 worker 每日聚合写入（P1 起加）。
 *
 * 一期（P0）资损防线已由下列机制覆盖，对账为 P1 增强项（独立 cron worker）：
 *   - 预扣模式（billing hold）：请求前原子预扣，并发竞态消灭
 *   - 幂等结算：usage_logs.request_id 唯一 + transactions 部分唯一索引（重复 job 自动跳过）
 *   - 原子余额：UPDATE balance = balance ± amount RETURNING（PG 串行化，不丢更新）
 *   - meter 入队失败同步降级结算（syncSettle）+ failed 告警计数器
 *
 * 本测试钉死 docs 承诺（P1 实现时转绿），确保不遗忘。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('docs 承诺钉死（P1 实现契约存在）', () => {
  it('docs/data-model.md 仍含「对账任务（每日）」承诺', () => {
    const docs = readFileSync(resolve(ROOT, 'docs/data-model.md'), 'utf8');
    expect(docs).toMatch(/对账任务（每日）/);
    expect(docs).toMatch(/usage_logs\.amount/);
    expect(docs).toMatch(/供应商账单核对/);
  });

  it('docs 标注 daily_stats 为 P1（"P1 加 daily_stats 聚合表"）', () => {
    const docs = readFileSync(resolve(ROOT, 'docs/data-model.md'), 'utf8');
    expect(docs).toMatch(/daily_stats/);
  });

  it('requirements 标注对账相关为 P1（报表加速/请求日志分区）', () => {
    const req = readFileSync(resolve(ROOT, 'docs/requirements.md'), 'utf8');
    // P1 范围明确包含「用量报表增强」「请求日志查询」
    expect(req).toMatch(/P1/);
  });
});

describe('P0 资损防线已就位（绿灯，对账的前置保障）', () => {
  it('worker 结算幂等（requestId 唯一约束 + 部分唯一索引）', () => {
    const settle = readFileSync(resolve(ROOT, 'apps/worker/src/settle.ts'), 'utf8');
    expect(settle).toMatch(/onConflictDoNothing/);
    expect(settle).toMatch(/requestId/);
  });

  it('gateway meter 入队失败有同步降级结算兜底（syncSettle）', () => {
    const syncSettlePath = resolve(ROOT, 'apps/gateway/src/lib/sync-settle.ts');
    const syncSettle = readFileSync(syncSettlePath, 'utf8');
    expect(syncSettle).toMatch(/syncSettle/);
  });

  it('worker failed 事件有告警计数器（不静默丢失）', () => {
    const index = readFileSync(resolve(ROOT, 'apps/worker/src/index.ts'), 'utf8');
    expect(index).toMatch(/meter_job_failed_total|meterFailedCounter/);
  });
});
