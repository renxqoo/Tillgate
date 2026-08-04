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

describe('死凭证达阈值应自动写回 DB status=4（红灯 = 风险确认）', () => {
  it('DeadCredentialTracker 达阈值 invalid 时应回写 DB channels.status（当前只写 Redis → 红）', () => {
    // 期望 tracker 在标记 invalid 的同时/之后，触发 DB 写 channels.status=4
    expect(
      TRACKER_SRC,
      'tracker 应在达阈值时回写 DB（当前只调 storage/compareAndSet，不碰 DB）',
    ).toMatch(/db\.|drizzle|update\(channels|@ai-gateway\/db/);
  });

  it('gateway 应有 db.update(channels).set({status:4}) 自动写回路径（当前无 → 红）', () => {
    expect(
      /update\(channels\)\.set\([\s\S]*status:\s*4/.test(GATEWAY_SRC) ||
        /db\.update\(channels\)/.test(GATEWAY_SRC),
      '应有自动把死凭证渠道置 status=4 的 DB 写回路径',
    ).toBe(true);
  });

  it('admin-api 应有死凭证自动置 4 逻辑（当前仅人工 PATCH body.status → 红）', () => {
    // 期望存在 deadCredential/failCount 触发 status=4 的自动逻辑
    expect(
      /deadCredential[\s\S]*status:\s*4/i.test(ADMIN_SRC) ||
        /failCount[\s\S]*>=\s*\d+[\s\S]*status:\s*4/s.test(ADMIN_SRC),
      'admin-api 应有基于失败/死凭证的自动置 4 逻辑',
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
