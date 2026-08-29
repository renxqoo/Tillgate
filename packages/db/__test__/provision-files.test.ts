/**
 * provision 前置文件结构不变量。
 *
 * provision-fresh 在「空库、journal 全未应用」时先于 journal 执行，因此各前置
 * 文件的写操作（INSERT/UPDATE/DELETE/ALTER）只能引用列表中更早文件 CREATE 的表。
 * 违反者（如 0097 曾 INSERT 0084 才建的 endpoint_permissions）在空库引导必炸——
 * 2026-08-29 AIO 首启实证；本测试把该类缺陷挡在门禁内。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROVISION_FILES } from '../scripts/provision-files.js';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

/** 去注释后按语句切分（与 provision-fresh 的执行切分同款规则） */
function statementsOf(file: string): string[] {
  const sql = readFileSync(resolve(scriptsDir, '../scripts', file), 'utf8');
  return sql
    .split('--> statement-breakpoint')
    .map((stmt) =>
      stmt
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join('\n'),
    )
    .filter((stmt) => stmt.trim().length > 0);
}

function uniqueMatches(stmts: string[], pattern: RegExp): string[] {
  const found = new Set<string>();
  for (const stmt of stmts) {
    for (const m of stmt.matchAll(pattern)) {
      const [, name] = m;
      if (name != null) found.add(name.toLowerCase());
    }
  }
  return [...found];
}

describe('provision-fresh 前置文件', () => {
  it('列表非空且文件都存在', () => {
    expect(PROVISION_FILES.length).toBeGreaterThan(0);
    for (const file of PROVISION_FILES) {
      expect(() => statementsOf(file)).not.toThrow();
    }
  });

  it('写操作只引用列表中更早文件创建的表（空库可先行执行）', () => {
    const createdSoFar = new Set<string>();
    const violations: string[] = [];
    for (const file of PROVISION_FILES) {
      const stmts = statementsOf(file);
      for (const table of uniqueMatches(
        stmts,
        /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi,
      )) {
        createdSoFar.add(table);
      }
      const writeTargets = uniqueMatches(
        stmts,
        // 负向前瞻排除触发器事件表（before update or delete on …）与
        // FK 动作（on update cascade）等关键字——它们不是写目标
        /\b(?:insert\s+into|update|delete\s+from|alter\s+table)\s+(?:only\s+)?(?!(?:or|on|and|set|of|cascade|restrict|no|action)\b)([a-z_][a-z0-9_]*)/gi,
      );
      for (const target of writeTargets) {
        if (!createdSoFar.has(target)) {
          violations.push(`${file} 写入 ${target}，但该表不由更早的前置文件创建`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
