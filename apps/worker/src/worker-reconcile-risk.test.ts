import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TDD 红灯：对账任务应已实现（docs 承诺但代码缺位）。
 *
 * 定位：docs/data-model.md:398-401 承诺「对账任务（每日）」：
 *   - Sigma usage_logs.amount (status=0) == Sigma transactions(consume) == Sigma users.balance 增减
 *   - Sigma usage_logs.upstream_cost 与 供应商账单核对
 *   - 不一致 则告警与人工核查
 * 另：data-model.md:340 承诺 daily_stats 聚合表由 worker 每日聚合写入。
 *
 * 期望（安全行为）：余额是资损核心，应有每日对账自动核对三方一致性，
 *   不一致即告警。至少满足下列之一：
 *     (a) 存在 reconcile/reconciliation 标识符实现，或
 *     (b) 存在 daily_stats 聚合写入路径，或
 *     (c) 存在 cron/定时器触发的核对 Worker。
 *
 * 当前实现：全仓静态扫描均无。以下断言全部报红 = 风险确认存在。
 * 补实现对账后（如新增 reconcile worker），对应断言转绿。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function collectSrc(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const ent of readdirSync(d)) {
      if (ent === 'node_modules' || ent === 'dist' || ent === '.next' || ent.startsWith('.')) continue;
      const full = resolve(d, ent);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (ent.endsWith('.ts') && !ent.endsWith('.test.ts') && !ent.endsWith('.d.ts'))
        parts.push(readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  return parts.join('\n\n');
}

const WORKER_SRC = collectSrc(resolve(ROOT, 'apps/worker/src'));
const GATEWAY_SRC = collectSrc(resolve(ROOT, 'apps/gateway/src'));

describe('对账任务应已实现（红灯 = 风险确认）', () => {
  it('worker 应存在 reconcile/reconciliation 对账实现（当前无 → 红）', () => {
    expect(
      /\breconcile\b/i.test(WORKER_SRC) || /reconciliation/i.test(WORKER_SRC),
      '应实现每日对账（docs/data-model.md:398 承诺）',
    ).toBe(true);
  });

  it('worker 应存在 daily_stats 聚合写入路径（当前无 → 红）', () => {
    expect(
      /dailyStats|daily_stats/i.test(WORKER_SRC),
      '应按天聚合写 daily_stats（docs/data-model.md:340 承诺）',
    ).toBe(true);
  });

  it('应存在 cron/定时器触发对账（当前无 setInterval/cron → 红）', () => {
    expect(
      /setInterval|cron\.schedule|node-cron|CronJob/.test(WORKER_SRC),
      '对账应有定时触发机制',
    ).toBe(true);
  });

  it('gateway 侧也不应有对账缺位（当前 gateway 同样无 → 红）', () => {
    expect(
      /\breconcile\b|reconciliation/i.test(GATEWAY_SRC),
      '若对账在 gateway 实现，此处应有标识',
    ).toBe(true);
  });
});

describe('docs 承诺钉死（契约存在，绿）', () => {
  it('docs/data-model.md 仍含「对账任务（每日）」承诺', () => {
    const docs = readFileSync(resolve(ROOT, 'docs/data-model.md'), 'utf8');
    expect(docs).toMatch(/对账任务（每日）/);
    expect(docs).toMatch(/usage_logs\.amount/);
    expect(docs).toMatch(/供应商账单核对/);
  });
});
