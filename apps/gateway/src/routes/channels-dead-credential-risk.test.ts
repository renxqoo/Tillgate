import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 风险回归验证（检测而非修复）：死凭证无自动检测 + 写回 DB。
 *
 * 定位：channels.ts:33 有 status=4 字段（schema 注释「凭据无效 连续 401/403，换 Key 后恢复」）
 *
 * 事实链（源码静态分析）：
 *   1. DeadCredentialTracker（packages/ai/src/dead-credential/tracker.ts）确实会检测 401/403：
 *        连续失败达阈值 -> state.status='invalid'
 *   2. 但该状态只写到「Redis」(DeadCredentialStorage)，从不写回 DB channels.status=4。
 *   3. channels.status 在代码中只有两种写入路径：
 *        - admin-api PATCH /channels/:id body.status（人工改）
 *        - 换 Key 时 failCount/cooldownUntil 重置（但 status 本身不自动置 4）
 *   4. 因此 401/403 永远不会自动把渠道标记为 status=4。
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
const SCHEMA_SRC = read('packages/db/src/schema/channels.ts');

describe('[风险] 死凭证检测存在，但从不写回 DB channels.status=4', () => {
  it('schema 字段 status 注释明确承诺 status=4 = 凭据无效（连读 401/403）', () => {
    expect(SCHEMA_SRC).toMatch(/status:\s*0\s*启用|凭据无效|401\/403/);
  });

  it('DeadCredentialTracker 检测死凭证 -> 标记 invalid（但目标是 storage 不是 DB）', () => {
    expect(TRACKER_SRC).toMatch(/status:\s*['"]invalid['"]/);
    // tracker 只调 this.storage 或 compareAndSet（Redis），不引用 DB
    expect(TRACKER_SRC).not.toMatch(/db\.|drizzle|update\(channels|@ai-gateway\/db/);
  });

  it('gateway 源码中无 db.update(channels).set({ status: 4 }) 写回路径', () => {
    expect(GATEWAY_SRC).not.toMatch(/update\(channels\)\.set\([\s\S]*status:\s*4/);
    expect(GATEWAY_SRC).not.toMatch(/db\.update\(channels\)/);
  });

  it('admin-api PATCH channels 仅透传 body.status（人工），无自动置 4 逻辑', () => {
    expect(ADMIN_SRC).toMatch(/body\.status\s*!==\s*undefined.*update\.status\s*=\s*body\.status/s);
    expect(ADMIN_SRC).not.toMatch(/deadCredential[\s\S]*status:\s*4/i);
    expect(ADMIN_SRC).not.toMatch(/failCount[\s\S]*>=\s*\d+[\s\S]*status:\s*4/s);
  });

  it('换 Key 时重置 failCount/cooldownUntil，但不重置 status（侧面证明 status 不走自动路径）', () => {
    const keyChangeBlock = ADMIN_SRC.match(
      /body\.apiKey\s*!==\s*undefined[\s\S]*?failCount\s*=\s*0[\s\S]*?cooldownUntil\s*=\s*null/,
    );
    expect(keyChangeBlock, '应在换 Key 分支看到 failCount=0 + cooldownUntil=null').toBeTruthy();
    expect(keyChangeBlock![0]).not.toMatch(/update\.status\s*=\s*0|status:\s*0/);
  });
});
