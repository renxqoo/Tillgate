import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TDD 红灯：死凭证达阈值应自动写回 DB channels.status=4。
 *
 * 定位：channels.ts:33 有 status=4 字段（schema 注释「凭据无效 连续 401/403，换 Key 后恢复」）
 *
 * 期望（安全行为）：
 *   DeadCredentialTracker 检测到连续 401/403 达阈值 → 应把该渠道在 DB 标记 status=4，
 *   使其永久退出路由（直到换 Key）。这样管理端列表/告警能直接看到死凭证渠道。
 *
 * 当前实现：Tracker 只写 Redis（DeadCredentialStorage）标记 invalid，
 *   从不写 DB channels.status=4。全仓无 db.update(channels).set({status:4}) 自动路径。
 *   以下断言全部报红 = 风险确认存在。
 *   补上写回后（tracker 达阈值时 update channels set status=4），对应断言转绿。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

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

const TRACKER_SRC = read('packages/ai/src/dead-credential/tracker.ts');
const GATEWAY_SRC = collectSrc(resolve(ROOT, 'apps/gateway/src'));
const ADMIN_SRC = collectSrc(resolve(ROOT, 'apps/admin-api/src'));

describe('死凭证达阈值应自动写回 DB status=4（绿灯 = 已修复）', () => {
  it('DeadCredentialTracker 检测死凭据并标记 invalid（检测能力，ai 包纯逻辑不碰 DB）', () => {
    // 架构：tracker 在 ai 包内只做检测 + Redis 状态（storage 注入），不直接依赖 DB
    // DB 写回由 gateway 调用方在检测到 invalid_api_key 后触发（见下一条断言）
    expect(TRACKER_SRC, 'tracker 应标记 invalid 状态').toMatch(/status:\s*['"]invalid['"]/);
  });

  it('gateway 应有 db.update(channels).set({status:4}) 自动写回路径', () => {
    // 允许链式调用跨行（update(channels) 后换行再 .set）
    expect(
      /update\(channels\)[\s\S]*?\.set\(\s*\{[\s\S]*?status:\s*4/.test(GATEWAY_SRC),
      'gateway 应有把死凭证渠道置 status=4 的 DB 写回路径（dead-credential-persist.ts）',
    ).toBe(true);
  });

  it('gateway 应有死凭证检测 → 自动置 status=4 的逻辑（invalid_api_key 触发 markChannelDeadCredential）', () => {
    // 架构：死凭据检测在上游调用方（gateway），admin-api 只做人工管理。
    // gateway 源码应含 markChannelDeadCredential（写回 DB status=4）+ isDeadCredentialError 判定。
    expect(
      /markChannelDeadCredential/.test(GATEWAY_SRC),
      'gateway 应调用 markChannelDeadCredential 写回 DB status=4',
    ).toBe(true);
    expect(
      /isDeadCredentialError/.test(GATEWAY_SRC),
      'gateway 应有 isDeadCredentialError 判定（invalid_api_key → 死凭据）',
    ).toBe(true);
  });

  it('换 Key 时应重置 status 回 0（当前换 Key 不动 status → 红）', () => {
    // 期望：换 Key 分支不仅重置 failCount/cooldownUntil，还应把 status 置回 0
    const keyChangeBlock = ADMIN_SRC.match(
      /body\.apiKey\s*!==\s*undefined[\s\S]*?failCount\s*=\s*0[\s\S]*?cooldownUntil\s*=\s*null/,
    );
    expect(keyChangeBlock, '应在换 Key 分支看到 failCount=0 + cooldownUntil=null').toBeTruthy();
    expect(
      /update\.status\s*=\s*0|status:\s*0/.test(keyChangeBlock![0]),
      '换 Key 应同时把 status 重置回 0（恢复路由）',
    ).toBe(true);
  });
});

describe('事实自检（绿，佐证检测链路存在但写回缺位）', () => {
  it('DeadCredentialTracker 确实会检测 401/403 并标记 invalid', () => {
    // 检测能力存在（绿），证明缺的是"写回 DB"这一步
    expect(TRACKER_SRC).toMatch(/status:\s*['"]invalid['"]/);
  });
});
